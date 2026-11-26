"""测试用真实 PNG 构造器。像素/边长上限在完整解码**之前**按 IHDR 声明尺寸检查，
故尺寸上限用例可用「仅头」PNG（小字节、大声明尺寸）；损坏/截断用例则必须真解码拒绝。"""

from __future__ import annotations

import base64
import struct
import zlib

# 真实可解码的 1x1 PNG（model 路径 happy-path 用）
PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _ihdr(width: int, height: int) -> bytes:
    return struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)


def png_bytes(width: int = 1, height: int = 1) -> bytes:
    raw = b"".join(b"\x00" + b"\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", _ihdr(width, height))
        + _chunk(b"IDAT", zlib.compress(raw))
        + _chunk(b"IEND", b"")
    )


def png_header_bytes(width: int, height: int) -> bytes:
    """仅签名+IHDR+IEND：字节极小但声明尺寸巨大，用于像素/边长上限用例。"""
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", _ihdr(width, height)) + _chunk(b"IEND", b"")


def make_png_b64(width: int = 1, height: int = 1) -> str:
    return base64.b64encode(png_bytes(width, height)).decode()


def make_png_header_b64(width: int, height: int) -> str:
    return base64.b64encode(png_header_bytes(width, height)).decode()