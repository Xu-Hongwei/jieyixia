# 后端 · 契约桩服务

「截下来」的无状态智能代理。**不建库、不建表、不落用户原图、无鉴权**（PRD 第 34、365 行）。

契约版本 **v0.2**（`schema_version 0.2.0`）：键集合按内容类型封闭、per-key 值类型、deadline 单值、derived⇒unresolved、candidate 不得 null，全部机器校验。定案与理由见 [`contract/REVIEW-v0.2.md`](../contract/REVIEW-v0.2.md)（已实施，待团队追认）。

当前阶段：`JXL_PROVIDER=fixture`，按 `source_id` 返回 `fixtures/` 里的 `expected_analysis`，让前端在真实模型接入前就能联调完整 HTTP 行为。

## 跑起来

本机已具备 fastapi 0.136.1 / uvicorn 0.46.0 / pydantic 2.10.6 / pytest 9.0.3 / httpx 0.28.1，**无需安装依赖**。

```bash
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

若装了 fastapi-cli，也可用 `fastapi dev`（入口已在 `pyproject.toml` 的 `[tool.fastapi]` 声明）。

启动日志会打印可用的 `source_ids`，前端照着发请求即可：

```json
{"event": "startup", "provider": "fixture", "source_ids": ["src-01", "src-02", "src-03", "src-04"], ...}
```

交互式文档：`http://127.0.0.1:8000/docs`

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/healthz` | 返回 `model_ready` / `api_version` / `schema_version`，驱动前端「AI 暂不可用」态 |
| `POST /api/analyze` |  body 为 `AnalyzeRequest`；返回 `AnalyzeResponse` |

### 给前端测降级路径的错误注入

```
POST /api/analyze?fail=413   → payload_too_large
POST /api/analyze?fail=422   → model_output_invalid
POST /api/analyze?fail=503   → model_unavailable
```

**仅桩服务有效**，接真实模型时移除。三条对应前端必须实现的降级：413 提示压缩重试、422 落 `Note.status=failed` 且保留原图、503 隐藏 AI 入口但保留「仅保存」。

### 请求示例

```bash
curl -X POST http://127.0.0.1:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"source_id":"src-01","kind":"image","image_base64":"<任意非空串>","captured_at":"2026-11-17T09:12:00+08:00"}'
```

桩阶段 `image_base64` 内容不被使用，非空即可。可用的 `source_id`：`src-01` 课程通知、`src-02` 评分补充（含相对时间 unresolved）、`src-03` 改期通知、`src-04` 参考资料（text 类型，`kind` 必须为 `text`）。

## 结构

```
app/
  _contract.py      把仓库根加入 sys.path，直接 import contract.models（不复制契约）
  config.py         os.environ 配置，无额外依赖
  errors.py         ApiFault + 全局异常映射（422/413/503/500），422 详情脱敏
  observability.py  脱敏结构化日志，_FORBIDDEN 兜底
  providers.py      AnalyzeProvider 协议 + FixtureProvider + ModelProvider + 依赖注入
  api.py            两个 router，各自声明 prefix/tags
  main.py           create_app()：CORS、异常处理、请求体上限、lifespan
  model/
    base.py         ModelProfile（不含密钥）+ VisionModel 协议 + ModelError + 状态码分类
    adapters.py     openai / anthropic / gemini 三种协议适配器，httpx 直连
    core.py         厂家无关：SYSTEM_PROMPT、输出解析、相对日期规范化
    registry.py     多 profile 装载、密钥解析、失败降级
tests/              114 条测试，含隐私边界、NO_PROXY 回归、chunked 体积校验、日期归一化与序列化规范回归
```

**换厂家不改代码**：只改 `JXL_MODELS` 配置。prompt、解析、规范化、契约、前端全都不动。

## 多厂家模型层

`JXL_PROVIDER=model` 启用。配置见 `.env.example`，要点：

- **`JXL_MODELS` 里只写密钥的环境变量名（`api_key_env`），不写密钥本身**，所以这段配置可以入库、可以发给队友；密钥留在各自 `.env`。
- 缺密钥的 profile 自动跳过；按数组顺序或 `JXL_MODEL_ORDER` 依次尝试，失败自动降级到下一个。
- 三种协议：`openai`（兼容 OpenAI / DeepSeek / Kimi / 智谱 / 通义兼容模式 / 硅基流动 / OpenRouter / Ollama / vLLM）、`anthropic`、`gemini`。**不引入任何厂家 SDK**——引 SDK 就等于写死厂家。
- 密钥一律走请求头。Gemini 用 `x-goog-api-key` 而非 URL query，避免密钥出现在日志与异常里。
- 降级触发条件：429 限流、5xx、超时、网络错误，**以及模型输出不合契约**。401/403 不重试，直接换下一个。
- 全部失败 → 503 `model_unavailable`；全部输出不合契约 → 422 `model_output_invalid`。前端降级路径不变。

### 相对日期由后端算，不交给模型

模型只输出 `raw` 原文 + `status: unresolved` + `value: null`；`core.resolve_relative_date()` 用 `captured_at` 做确定性换算，填 `value` 并标 `derived: true`，**状态仍是 unresolved**，同时追加 `relative_date_derived` warning。

这样换算可单测、可复现，且不会伪造事实（PRD 规则 7）。支持 今天/明天/后天/大后天/本周X/这周X/下周X/下下周X/ bare 周X（取严格晚于保存日的下一次）。

**明确日期优先于相对词**（真实样本教训）：`extract_explicit_date()` 先抽原文里的明确日期——「本周二（5.12）」取 5.12 而非按「本周二」推算；带年份 → `candidate`，缺年份（含 `5.12`、`9月19日` 点号/月日格式）→ 参照保存时间补年份 + `derived + unresolved` + `date_year_inferred` warning。只有相对词时才走 `resolve_relative_date()`。

**datetime 序列化统一为 `YYYY-MM-DDTHH:MM:SS±HH:MM`**（`canonical_datetime()`）：缺秒补 `:00`；缺时区用 `captured_at` 的偏移（有参照，不算编造）；参照本身无时区则不补，绝不默认 UTC；`Z` 归一为 `+00:00`；date-only 字符串原样保留。模型给的和我们推算的走同一条规范化路径，避免前端拿到两种形状。

**提示词 v2 的六处收紧**（都有真实失败案例驱动）：键集合按类型封闭、不得自创键；多截止节点时 `deadline` 取主截止、其余带标签进 `constraints`；礼貌语/纯背景原因/宣传语排除；`content_type` 给出判定标准（写作指南属 tutorial）；概括类字段的 `raw` 定义为支撑片段；时间窗口/地点归 `constraints`。复测 4 个问题样本 4/4 通过、零自创键。**注意 prompt 只是软约束**，键枚举与 per-key 值类型的硬保证留契约 v0.2。

> 注意：`fixtures/*.json` 里的 `expected_analysis` 是**后端最终输出**（已含规范化结果），不是模型原始输出。

### 两个环境坑

1. **`NO_PROXY` 含 `[::1]` 会让 httpx 崩**。httpx 把 NO_PROXY 条目当 URL 模式解析，`[::1]` 被解析成端口 `:1]` 抛 `InvalidURL`，本机所有默认 `httpx.Client()` 都会失败。模型调用一律 `trust_env=False`；需要代理时显式设 `JXL_HTTPS_PROXY`。`test_ambient_no_proxy_does_not_break_real_client` 守着这条（必须走真实 client 构造，MockTransport 会绕过该 bug）。
2. **图片 mime 由字节头嗅探**（PNG/JPEG/WebP），兼容前端直接传 data URL，因此不必为 mime 改契约。

## 配置

复制 `.env.example` 为 `.env`（**`.env` 已在根 `.gitignore` 中，绝不入库**）。当前生效的是前三项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JXL_PROVIDER` | `fixture` | `fixture`（桩）/ `model`（多厂家真实模型） |
| `JXL_MAX_BODY_BYTES` | `8388608` | 请求体上限；`Content-Length` 与 chunked 实际字节都拦 |
| `JXL_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Vite 默认端口 |
| `JXL_MODELS` | 空 | profile 数组，见 `.env.example`；只含密钥的环境变量名 |
| `JXL_MODEL_ORDER` | 空 | 显式尝试顺序，留空按数组顺序 |
| `JXL_HTTPS_PROXY` | 空 | 显式代理；不读系统代理环境变量 |

体积校验由纯 ASGI 中间件 `BodyLimitMiddleware` 完成：先按 `Content-Length` 快拒，再自己带上限地读完 body 并回放给下游，chunked 超限同样 413。**不能从 `receive` 里抛异常**——FastAPI 的 body 解析会把它吞成 400；也不能用 `@app.middleware("http")` 改 `request._receive`——`call_next` 读的是原始 receive。

## 测试

```bash
cd backend
python -m pytest
```

114 条，分五组：

- `test_api.py` — 契约符合性（响应用 `AnalyzeResponse` 反序列化校验）、无 confirmed 字段、candidate 必带 quote、相对时间保持 unresolved+derived、missing 字段为 null、刻意保留的 AI 识别错误、确定性、各类 422/413/503。
- `test_privacy.py` — **422 响应不回显 image_base64 与原文**、错误详情只含 `loc/msg/type`、日志脱敏、分析日志只含元数据。
- `test_model_adapters.py` — 三种协议的请求形状与文本提取、密钥走请求头（Gemini 不进 URL）、状态码→错误类型映射、厂家错误消息里的密钥被脱敏、超时/非 JSON/结构缺失、`NO_PROXY` 回归。
- `test_model_core.py` — 相对日期换算 12 例、Markdown 代码块剥离、missing 归零、quote 回退、拒绝 confirmed/非法类型/空字段、错误消息不泄漏用户内容。
- `test_model_registry.py` — 配置装载与校验、缺密钥跳过、限流降级、auth 不重试、retries 生效、输出不合契约也降级、API 层 503/422 映射、healthz 就绪态、密钥与图片不外泄。

全部用 `httpx.MockTransport`，**不联网、不需要真密钥**。另有真实 HTTP 端到端验证（本地假厂家 + 双 profile 降级），见 devlog。契约层另有 `contract/selftest.py` **24 条负向用例**（含 6 条 v0.2 硬约束），证明守卫不是恒真。

隐私测试不是形式：FastAPI 默认的 422 处理会把请求 `input` 原样回显，其中就有整张图片的 base64。`errors.py` 的 `_safe_errors()` 专门剥掉它，`test_422_does_not_echo_image_base64` 守着这条。

## 已知边界

- 桩服务不缓存分析结果，也不记录 `source_id` 历史。后端无副作用，幂等由前端的 `source_id` 保证（重试不会在前端产生第二份资料）。这样后端不留存任何用户内容。
- `FixtureProvider` 在进程启动时一次性读入 fixture，改 fixture 需重启（`--reload` 会自动重启）。
- 模型层已用**真实密钥 + 真实厂家**验证：DashScope `qwen3.8-flash`（`base_url_env=DASHSCOPE_BASE_URL`），图片与文字双模态均 HTTP 200 且契约校验通过，图片 6 字段正确归位、`deadline=2026-11-19`。
- **思考模型要关思考**：`qwen3.8-flash` 默认输出 `reasoning_content`，同一 prompt 开思考 ~39s、关思考 ~10s，思考过长还会撞超时。配置里用 `extra_body: {"enable_thinking": false}`。结构化抽取不需要思维链。
- prompt 区分「抽取类字段」（逐字）与「概括类字段」（summary/keywords 可归纳但必须带支撑引用）；并给出 notice 各字段语义防止串位（后果句进 reminder 而非 constraints）。
- 解析守卫：模型给出 `candidate` 却无值时降级为 `missing`，并追加 `candidate_without_value` warning，不静默吞掉。
- 请求体上限对 `Content-Length` 与 chunked 都生效（任务 #8 已关闭）。中间件会把 body 缓冲到上限以内再回放，内存占用上限即 `JXL_MAX_BODY_BYTES`。
- `ModelProvider` 的 router 懒构建：没配 `JXL_MODELS` 时服务仍能启动，`/api/healthz` 返回 `model_ready: false`，前端据此降级到「仅保存」。
