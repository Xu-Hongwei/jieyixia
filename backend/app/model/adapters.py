"""三种协议适配器。用 httpx 直连，不引入任何厂家 SDK。

base_url 约定：
  openai    https://api.deepseek.com/v1          → 拼 /chat/completions
  anthropic https://api.anthropic.com            → 拼 /v1/messages
  gemini    https://generativelanguage.googleapis.com → 拼 /v1beta/models/{model}:generateContent

密钥一律走请求头，绝不拼进 URL（Gemini 支持 x-goog-api-key），避免出现在日志与异常里。
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .base import ModelError, ModelProfile, classify_status


def _redact(text: str, secret: str) -> str:
    if secret and secret in text:
        return text.replace(secret, "[redacted]")
    return text


class _HttpAdapter:
    protocol = ""

    def __init__(self, profile: ModelProfile, api_key: str, transport: httpx.BaseTransport | None = None) -> None:
        self.profile = profile
        self.name = profile.name
        self._key = api_key
        self._transport = transport

    def _post(self, url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
        # trust_env=False：httpx 会把 NO_PROXY 条目当 URL 解析，形如 [::1] 的条目会直接抛
        # InvalidURL，导致本机所有模型调用失败。代理改为显式配置，不受运行环境影响。
        proxy = os.environ.get("JXL_HTTPS_PROXY", "").strip() or None
        try:
            with httpx.Client(
                timeout=self.profile.timeout_s,
                transport=self._transport,
                trust_env=False,
                proxy=proxy,
            ) as client:
                response = client.post(url, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise ModelError("timeout", f"{self.name} 请求超时", True, self.name) from exc
        except httpx.HTTPError as exc:
            raise ModelError("transport", f"{self.name} 网络错误", True, self.name) from exc

        if response.status_code >= 400:
            kind, retryable = classify_status(response.status_code)
            raise ModelError(kind, self._vendor_message(response), retryable, self.name)

        try:
            return response.json()
        except ValueError as exc:
            raise ModelError("invalid_output", f"{self.name} 返回非 JSON", True, self.name) from exc

    def _vendor_message(self, response: httpx.Response) -> str:
        detail = ""
        try:
            body = response.json()
            error = body.get("error")
            if isinstance(error, dict):
                detail = str(error.get("message", ""))
            elif isinstance(error, str):
                detail = error
        except ValueError:
            detail = response.text[:200]
        detail = _redact(detail, self._key)[:200]
        return f"{self.name} HTTP {response.status_code} {detail}".strip()

    @staticmethod
    def _user_content(user_text: str, image_b64: str | None, media_type: str) -> Any:
        raise NotImplementedError

    def complete(self, *, system: str, user_text: str, image_b64: str | None, media_type: str) -> str:
        raise NotImplementedError


class OpenAICompatibleAdapter(_HttpAdapter):
    """覆盖 OpenAI / DeepSeek / Kimi / 智谱 / 通义兼容模式 / 硅基流动 / OpenRouter / Ollama / vLLM。"""

    protocol = "openai"

    def complete(self, *, system: str, user_text: str, image_b64: str | None, media_type: str) -> str:
        if image_b64:
            content: Any = [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
            ]
        else:
            content = user_text

        payload: dict[str, Any] = {
            "model": self.profile.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "max_tokens": self.profile.max_tokens,
            "temperature": 0,
        }
        if self.profile.json_mode:
            payload["response_format"] = {"type": "json_object"}
        payload.update(self.profile.extra_body)

        data = self._post(
            self.profile.base_url.rstrip("/") + "/chat/completions",
            {"Authorization": f"Bearer {self._key}"},
            payload,
        )
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelError("invalid_output", f"{self.name} 响应结构缺少 choices", True, self.name) from exc


class AnthropicAdapter(_HttpAdapter):
    protocol = "anthropic"

    def complete(self, *, system: str, user_text: str, image_b64: str | None, media_type: str) -> str:
        blocks: list[dict[str, Any]] = []
        if image_b64:
            blocks.append(
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}}
            )
        blocks.append({"type": "text", "text": user_text})

        payload = {
            "model": self.profile.model,
            "max_tokens": self.profile.max_tokens,
            "temperature": 0,
            "system": system,
            "messages": [{"role": "user", "content": blocks}],
        }
        payload.update(self.profile.extra_body)
        data = self._post(
            self.profile.base_url.rstrip("/") + "/v1/messages",
            {"x-api-key": self._key, "anthropic-version": "2023-06-01"},
            payload,
        )
        try:
            return "".join(b["text"] for b in data["content"] if b.get("type") == "text")
        except (KeyError, TypeError) as exc:
            raise ModelError("invalid_output", f"{self.name} 响应结构缺少 content", True, self.name) from exc


class GeminiAdapter(_HttpAdapter):
    protocol = "gemini"

    def complete(self, *, system: str, user_text: str, image_b64: str | None, media_type: str) -> str:
        parts: list[dict[str, Any]] = [{"text": user_text}]
        if image_b64:
            parts.append({"inline_data": {"mime_type": media_type, "data": image_b64}})

        url = f"{self.profile.base_url.rstrip('/')}/v1beta/models/{self.profile.model}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "maxOutputTokens": self.profile.max_tokens,
                "temperature": 0,
                "responseMimeType": "application/json",
            },
        }
        payload.update(self.profile.extra_body)
        data = self._post(url, {"x-goog-api-key": self._key}, payload)
        try:
            return "".join(p["text"] for p in data["candidates"][0]["content"]["parts"] if "text" in p)
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelError("invalid_output", f"{self.name} 响应结构缺少 candidates", True, self.name) from exc


ADAPTERS: dict[str, type[_HttpAdapter]] = {
    "openai": OpenAICompatibleAdapter,
    "anthropic": AnthropicAdapter,
    "gemini": GeminiAdapter,
}


def build_adapter(profile: ModelProfile, api_key: str, transport: httpx.BaseTransport | None = None) -> _HttpAdapter:
    adapter = ADAPTERS.get(profile.protocol)
    if adapter is None:
        raise ModelError("no_profile", f"未知协议 {profile.protocol}，可选：{', '.join(ADAPTERS)}", False, profile.name)
    return adapter(profile, api_key, transport)
