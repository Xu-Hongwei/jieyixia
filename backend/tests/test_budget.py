"""统一总时限回归：单请求+重试+退避+切换 profile 共用同一预算；剩余不足即停并走现有降级。

全部用本地假模型（httpx.MockTransport / 假 adapter），不联网、不产生真实模型费用。
"""

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelError, ModelProfile
from app.model.registry import ModelRouter
from app.providers import ModelProvider, get_provider
from helpers import PNG_1X1

GOOD = {"choices": [{"message": {"content": json.dumps({
    "content_type": "notice",
    "fields": [{"key": "title", "value": "T", "raw": "原文", "status": "candidate"}],
})}}]}


def _profile(name: str, **kw) -> ModelProfile:
    base = {"name": name, "protocol": "openai", "base_url": f"https://{name}.test/v1",
            "model": "m", "api_key_env": "K_" + name}
    base.update(kw)
    return ModelProfile(**base)


def _adapter(name: str, handler, **kw) -> OpenAICompatibleAdapter:
    return OpenAICompatibleAdapter(_profile(name, **kw), "k", httpx.MockTransport(handler))


def _ok(request):
    return httpx.Response(200, json=GOOD)


def _status(code):
    def handler(request):
        return httpx.Response(code, json={"error": {"message": "boom"}})
    return handler


def _slow_ok(delay):
    def handler(request):
        time.sleep(delay)
        return httpx.Response(200, json=GOOD)
    return handler


def _slow_fail(delay, code=500):
    def handler(request):
        time.sleep(delay)
        return httpx.Response(code, json={"error": {"message": "boom"}})
    return handler


def test_slow_response_within_budget_succeeds():
    router = ModelRouter([_adapter("a", _slow_ok(0.05))])
    start = time.perf_counter()
    result, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=5)
    assert name == "a"
    assert time.perf_counter() - start < 5


def test_primary_fail_backup_success():
    router = ModelRouter([_adapter("a", _status(500), retries=0), _adapter("b", _ok)])
    result, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=5)
    assert name == "b"


def test_all_fail_raises_unavailable():
    router = ModelRouter([_adapter("a", _status(500), retries=0), _adapter("b", _status(503), retries=0)])
    with pytest.raises(ModelError) as info:
        router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=5)
    assert info.value.kind == "unavailable"


def test_budget_exhausted_stops_early_and_is_bounded():
    calls: list = []

    def handler(request):
        calls.append(1)
        time.sleep(0.2)
        return httpx.Response(500, json={"error": {"message": "boom"}})

    # retries=3 → 若无预算会尝试 4 次 + 退避；预算 0.5s 应在第一次失败后的退避前就停
    router = ModelRouter([_adapter("a", handler, retries=3)])
    start = time.perf_counter()
    with pytest.raises(ModelError) as info:
        router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=0.5)
    elapsed = time.perf_counter() - start
    assert info.value.kind == "timeout"
    assert info.value.retryable is True
    assert len(calls) == 1, "预算耗尽后不得继续尝试"
    assert elapsed < 1.0, f"总等待必须有界，实际 {elapsed:.2f}s"


def test_per_call_deadline_clamped_to_remaining_budget():
    seen: list = []

    class FakeAdapter:
        name = "a"
        profile = _profile("a", timeout_s=90.0, retries=0)

        def complete(self, *, system, user_text, image_b64, media_type, deadline=None):
            seen.append(deadline)
            raise ModelError("timeout", "slow", True, self.name)

    router = ModelRouter([FakeAdapter()])
    before = time.monotonic()
    with pytest.raises(ModelError):
        router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=2.0)
    # 适配器拿到的是绝对截止（monotonic 基准），且不超过 起始+预算；读取阶段据此钳制并中断
    assert seen and seen[0] is not None
    assert before < seen[0] <= before + 2.0 + 0.05, "单请求必须收到被预算钳制的绝对截止"


def test_api_budget_exhaustion_maps_to_503_and_bounded(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "model")
    monkeypatch.setenv("JXL_ANALYZE_BUDGET_S", "0.5")
    get_settings.cache_clear()
    get_provider.cache_clear()
    calls: list = []

    def handler(request):
        calls.append(1)
        time.sleep(0.2)
        return httpx.Response(500, json={"error": {"message": "boom"}})

    provider = ModelProvider(router=ModelRouter([_adapter("a", handler, retries=3)]))
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: provider
    body = {"source_id": "src-x", "kind": "image", "image_base64": PNG_1X1,
            "captured_at": "2026-11-17T09:12:00+08:00"}
    start = time.perf_counter()
    with TestClient(app) as client:
        response = client.post("/api/analyze", json=body)
    elapsed = time.perf_counter() - start
    get_settings.cache_clear()
    get_provider.cache_clear()
    assert response.status_code == 503
    assert response.json()["code"] == "model_unavailable"
    assert len(calls) == 1
    assert elapsed < 1.5, f"API 总等待必须有界，实际 {elapsed:.2f}s"


# ---------------------------------------------------------------- 真实本地 HTTP 假服务
# MockTransport 一次性返回整段 body，无法复现「分段慢响应每段都在 read 间隔内到达、总时长无限拖长」。
# 这里用真实 socket 服务证明：绝对截止会在读取中途终止并释放连接（厂家侧检测到断开）。

import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GOOD_BYTES = json.dumps(GOOD).encode()


class _VendorHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _full(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            self.rfile.read(length)
        mode = self.server.mode
        disc = self.server.disconnects
        if mode == "ok":
            self._full(200, GOOD_BYTES)
        elif mode == "slow_ok":
            time.sleep(0.1)
            self._full(200, GOOD_BYTES)
        elif mode == "fail":
            self._full(500, b'{"error":{"message":"boom"}}')
        elif mode == "dribble":
            # 持续分段：每 0.05s 一段，共 30 段（~1.5s），每段都远小于 read 间隔
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(GOOD_BYTES) * 30))
            self.end_headers()
            try:
                for _ in range(30):
                    self.wfile.write(GOOD_BYTES)
                    self.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                disc.append("dribble")
        elif mode == "silent":
            # 只发头不发 body：read 阻塞，靠 read timeout（=剩余预算）兜底
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(GOOD_BYTES)))
            self.end_headers()
            try:
                time.sleep(0.4)  # 超过预算 0.3s，客户端 read 超时并关闭连接
                for _ in range(15):  # 多次写探测：客户端已断开则触发 OSError
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    time.sleep(0.02)
                self.wfile.write(GOOD_BYTES)
            except OSError:
                disc.append("silent")
        elif mode in ("huge_ok", "huge_error"):
            # 超大响应：64KiB × 40 段（~2.5MiB），验证客户端字节上限在中途截断并释放连接
            code = 200 if mode == "huge_ok" else 500
            chunk = b"x" * 65536
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(chunk) * 40))
            self.end_headers()
            try:
                for _ in range(40):
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(0.01)
            except OSError:
                disc.append(mode)


@contextmanager
def local_vendor(mode: str):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _VendorHandler)
    server.mode = mode
    server.disconnects = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _real_adapter(url: str, **kw) -> OpenAICompatibleAdapter:
    return OpenAICompatibleAdapter(_profile("real", base_url=url, **kw), "k", transport=None)


def test_real_dribble_response_aborted_by_budget_and_connection_released():
    with local_vendor("dribble") as (url, server):
        router = ModelRouter([_real_adapter(url, retries=0)])
        start = time.perf_counter()
        with pytest.raises(ModelError) as info:
            router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=0.3)
        elapsed = time.perf_counter() - start
        assert info.value.kind == "timeout"
        assert elapsed < 0.9, f"分段慢响应必须按总预算终止，实际 {elapsed:.2f}s（无修复会拖到 ~1.5s）"
        time.sleep(0.3)  # 让厂家侧检测到客户端断开
        assert server.disconnects, "超时后必须关闭响应释放连接，厂家应检测到断开"


def test_real_silent_response_aborted_by_budget():
    with local_vendor("silent") as (url, server):
        router = ModelRouter([_real_adapter(url, retries=0)])
        start = time.perf_counter()
        with pytest.raises(ModelError) as info:
            router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=0.3)
        elapsed = time.perf_counter() - start
        assert info.value.kind == "timeout"
        assert elapsed < 0.9, f"无响应必须按总预算终止，实际 {elapsed:.2f}s"
        time.sleep(0.4)
        assert server.disconnects, "无响应超时后连接也应释放"


def test_real_slow_response_within_budget_succeeds():
    with local_vendor("slow_ok") as (url, _server):
        router = ModelRouter([_real_adapter(url, retries=0)])
        start = time.perf_counter()
        result, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=2.0)
        assert name == "real"
        assert json.loads(result)["content_type"] == "notice"
        assert time.perf_counter() - start < 2.0


def test_real_primary_fail_backup_success():
    with local_vendor("fail") as (bad_url, _s1), local_vendor("ok") as (good_url, _s2):
        router = ModelRouter([_real_adapter(bad_url, retries=0), _real_adapter(good_url, retries=0)])
        result, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=3.0)
        assert name == "real"
        assert json.loads(result)["content_type"] == "notice"