"""Personal Qwen credentials are scoped to one request and one fixed upstream."""
import re

import httpx
from fastapi import APIRouter, Request

from ._contract import AnalyzeRequest, AnalyzeResponse, AssistantProposeResponse, LIMITS
from .api import analyze, propose
from .errors import ApiFault
from .guard import MODEL_QUOTA
from .model.adapters import OpenAICompatibleAdapter
from .model.base import ModelError, ModelProfile
from .model.registry import ModelRouter
from .providers import ModelProvider, ModelProposeProvider

router = APIRouter(prefix="/api/qwen", tags=["personal-qwen"])
HOST = "https://dashscope.aliyuncs.com"
MODEL = "qwen3.8-flash"
KEY_HEADER = "X-JXL-Qwen-Key"


def _key(request: Request) -> str:
    value = request.headers.get(KEY_HEADER, "")
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{8,200}", value):
        raise ApiFault(401, "qwen_key_invalid", "请输入北京地域的百炼 API Key。")
    return value


def _denied() -> ApiFault:
    return ApiFault(403, "qwen_key_denied", "千问拒绝了这次访问，请检查 Key 的地域和模型权限。")


class PersonalQwenAdapter(OpenAICompatibleAdapter):
    def complete(self, **kwargs):
        try:
            return super().complete(**kwargs)
        except ModelError as exc:
            if exc.kind == "auth":
                raise _denied() from None
            if exc.kind == "rate_limit":
                raise ApiFault(429, "qwen_rate_limited", "百炼额度不足或请求过于频繁，请检查额度后重试。", True) from None
            raise


def _router(key: str, max_tokens: int) -> ModelRouter:
    profile = ModelProfile(name=MODEL, protocol="openai", model=MODEL, api_key_env="",
                           base_url=HOST + "/compatible-mode/v1", max_tokens=max_tokens,
                           retries=0, extra_body={"enable_thinking": False})
    return ModelRouter([PersonalQwenAdapter(profile, key)], attempt_gate=MODEL_QUOTA.consume)


@router.post("/verify")
def verify(request: Request):
    key = _key(request)
    try:
        with httpx.Client(timeout=8, trust_env=False, follow_redirects=False) as client:
            response = client.get(HOST + "/api/v1/models", params={"model": MODEL, "page_size": 1},
                                  headers={"Authorization": "Bearer " + key})
        if response.status_code in (401, 403):
            raise _denied()
        if response.status_code == 429:
            raise ApiFault(429, "qwen_rate_limited", "百炼请求过于频繁，请稍后重试。", True)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("success") is not True:
            raise ValueError("unexpected catalog response")
    except (httpx.HTTPError, ValueError):
        raise ApiFault(503, "qwen_verify_unavailable", "暂时无法向百炼验证连接，请稍后重试。", True) from None
    return {"connected": True}


@router.post("/analyze")
def personal_analyze(payload: AnalyzeRequest, request: Request) -> AnalyzeResponse:
    return analyze(payload, ModelProvider(_router(_key(request), 4096)), fail=None)


@router.post("/propose")
async def personal_propose(request: Request) -> AssistantProposeResponse:
    provider = ModelProposeProvider(_router(_key(request), LIMITS["propose_profile_max_tokens"]["value"]))
    return await propose(request, provider, fail=None)
