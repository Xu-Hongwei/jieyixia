"""脱敏结构化日志。只记可安全外泄的元数据，绝不记图片、原文、引用。

PRD 第 365 行：不将图片或敏感内容写入普通运行日志。
这里的 _FORBIDDEN 是防御性兜底——即使调用方误传，也不会落盘。
"""

from __future__ import annotations

import json
import logging
from contextvars import ContextVar
from typing import Any

_FORBIDDEN = {"image_base64", "image", "raw", "quote", "text", "body", "draft_md", "authorization", "api_key"}

logger = logging.getLogger("jxl")

# 每请求一个 id，由 RequestIdMiddleware 设置；同步端点经 anyio 线程池会继承 contextvars
request_id_var: ContextVar[str | None] = ContextVar("jxl_request_id", default=None)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False


def log_event(event: str, **fields: Any) -> None:
    payload: dict[str, Any] = {"event": event}
    request_id = request_id_var.get()
    if request_id:
        payload["request_id"] = request_id
    for key, value in fields.items():
        if key.lower() in _FORBIDDEN:
            payload[key] = "[redacted]"
        else:
            payload[key] = value
    logger.info(json.dumps(payload, ensure_ascii=False, default=str))
