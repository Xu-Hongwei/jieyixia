"""厂家无关的模型层契约。

ModelProfile 不含密钥，可安全入库与打日志；密钥只存在于适配器实例中。
适配器只负责「把消息发出去、把文本拿回来」，prompt / 解析 / 规范化都在 core.py。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class ModelProfile:
    name: str
    protocol: str
    model: str
    api_key_env: str
    base_url: str = ""
    base_url_env: str = ""
    timeout_s: float = 90.0
    max_tokens: int = 2048
    json_mode: bool = True
    retries: int = 1
    extra_body: dict[str, Any] = field(default_factory=dict)


class ModelError(Exception):
    """kind: auth / rate_limit / timeout / server / transport / invalid_output / no_profile"""

    def __init__(self, kind: str, message: str, retryable: bool, profile: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.retryable = retryable
        self.profile = profile


class PlanOutputError(ModelError):
    """Only server-defined diagnostics may enter the retry prompt or logs."""

    def __init__(self, category: str, hint: str, path: str = "payload") -> None:
        super().__init__("invalid_output", hint, True)
        self.category = category
        self.hint = hint
        self.path = path
        self.attempts = 1
        self.repair_attempted = False
        # Optional request-local instructions and data for a scoped second call.
        # Neither is included in the public error or its diagnostic message.
        self.repair_inputs: tuple[str, str] | None = None
        self.review_snapshot: str = ""


class VisionModel(Protocol):
    name: str

    def complete(
        self,
        *,
        system: str,
        user_text: str,
        image_b64: str | None,
        media_type: str,
        deadline: float | None = None,
    ) -> str: ...


def classify_status(status: int) -> tuple[str, bool]:
    if status in (401, 403):
        return "auth", False
    if status == 429:
        return "rate_limit", True
    if status >= 500:
        return "server", True
    return "transport", False
