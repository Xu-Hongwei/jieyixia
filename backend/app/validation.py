"""输入校验：真实日历 + 真实模型路径的图片/文本上限。

契约（contract/models.py）只保证值的「形状」；这里补两件事，且都在调用模型之前完成：
  1. 真实日历合法性（2026-02-30、13 月、25 点这类形状合法但日历非法的值）；
  2. 资源上限（文字字数、图片解码字节、图片像素/边长），超限沿用现有错误结构。

桩模式（fixture）的占位图片（__INJECT_IMAGE_BASE64__ / 测试 marker）**不做内容校验**——
占位符不是真实图片；不能为了兼容测试而放宽生产校验。真实图片校验只发生在 model 路径。
"""

from __future__ import annotations

import base64
import binascii
import io

from PIL import Image, UnidentifiedImageError

from ._contract import AnalyzeRequest
from .errors import ApiFault
from .time_rules import TimeValueError, parse_iso_date, parse_iso_datetime

# 关掉 Pillow 自带的解压炸弹阈值，像素/边长上限由本模块按配置统一裁决（先查尺寸再解码）
Image.MAX_IMAGE_PIXELS = None


def _invalid(loc: str, msg: str) -> ApiFault:
    return ApiFault(
        422,
        "invalid_request",
        "请求不符合契约",
        False,
        [{"loc": [loc], "msg": msg, "type": "value_error"}],
    )


def _too_large(msg: str) -> ApiFault:
    return ApiFault(413, "payload_too_large", msg, True, None)


def check_calendar_date(value: str, loc: str) -> None:
    try:
        parse_iso_date(value)
    except TimeValueError as exc:
        raise _invalid(loc, f"{loc} 不是真实日历日期（YYYY-MM-DD）") from exc


def check_calendar_datetime(value: str, loc: str) -> None:
    try:
        parse_iso_datetime(value)
    except TimeValueError as exc:
        raise _invalid(loc, f"{loc} 不是合法日期时间（日历/时钟/时区偏移越界）") from exc


def validate_request_meta(req: AnalyzeRequest, *, max_text_chars: int) -> None:
    """请求级日历 + 文字上限。桩与真实模型都执行（与图片内容无关）。"""
    check_calendar_datetime(req.captured_at, "captured_at")
    if req.reference_at is not None:
        check_calendar_date(req.reference_at, "reference_at")
    if req.kind.value == "text" and req.text and len(req.text) > max_text_chars:
        raise _invalid("text", f"文字长度超过上限 {max_text_chars} 字")


_MEDIA_BY_FORMAT = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
# 损坏/截断/仅文件头的图片会让 Pillow 抛多种异常：仅头无 IDAT 时 verify() 抛 IndexError，
# 截断抛 OSError，非法结构抛 ValueError/SyntaxError。一律收敛成 422，绝不漏成内部错误。
_PILLOW_ERRORS = (UnidentifiedImageError, OSError, ValueError, SyntaxError, IndexError)


def strip_data_url(image_b64: str) -> str:
    """安全拆 data URL：畸形（缺逗号）返回 422，绝不抛 IndexError 进入内部错误。非 data URL 原样返回。"""
    if not image_b64.startswith("data:"):
        return image_b64
    if "," not in image_b64:
        raise _invalid("image_base64", "data URL 格式非法（缺少逗号分隔的 base64 数据）")
    return image_b64.split(",", 1)[1]


def inspect_image(
    image_b64: str,
    *,
    max_bytes: int,
    max_pixels: int,
    max_side: int,
) -> str:
    """真实模型路径：严格 base64 → 字节上限 → Pillow 完整解码（格式/损坏/截断）→ 像素/边长上限。

    仅文件头、截断、损坏的 PNG/JPEG/WebP 一律拒绝；不认识的内容绝不默认当 PNG。返回 media_type。
    """
    payload = strip_data_url(image_b64)
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _invalid("image_base64", "image_base64 不是合法 base64") from exc
    if not data:
        raise _invalid("image_base64", "image_base64 解码后为空")
    if len(data) > max_bytes:
        raise _too_large("图片解码后超出体积上限，请压缩后重试；原图已在本地保留")

    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt, (w, h) = im.format, im.size
    except _PILLOW_ERRORS as exc:
        raise _invalid("image_base64", "无法识别的图片格式（仅支持 PNG/JPEG/WebP）") from exc
    if fmt not in _MEDIA_BY_FORMAT:
        raise _invalid("image_base64", "无法识别的图片格式（仅支持 PNG/JPEG/WebP）")
    if w <= 0 or h <= 0:
        raise _invalid("image_base64", "图片尺寸非法")
    if w * h > max_pixels or max(w, h) > max_side:
        raise _too_large("图片像素超出上限，请压缩或裁剪后重试；原图已在本地保留")

    # 完整解码：verify 查结构完整性，load 真正解码像素——捕获仅文件头/截断 IDAT/损坏。
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
        with Image.open(io.BytesIO(data)) as im2:
            im2.load()
    except _PILLOW_ERRORS as exc:
        raise _invalid("image_base64", "图片损坏或截断，无法完整解码") from exc
    return _MEDIA_BY_FORMAT[fmt]