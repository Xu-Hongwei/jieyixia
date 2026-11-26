# 后端 · 契约 0.5.0

「截下来」的无状态智能代理。**不建库、不建表、不落用户原图**（PRD 第 34、365 行）。PRD 的「无鉴权」是本地/私有演示的默认形态；第七轮起提供**可选** Bearer 令牌鉴权（`JXL_API_TOKEN`，默认关闭、前端零改动）与限流/并发/每日费用额度——**公网部署必须显式开启鉴权**（见[滥用防护](#滥用防护第七轮)）。

契约版本 **0.5.0**（`schema_version 0.5.0`，API 路径 v1）：键集合按内容类型封闭、per-key 值类型、多时间节点 `time_nodes`、节点角色/参照为机器约束，越界即 422；0.5.0 起并入工作助手持久类型（`contract/assistant_models.py`，仅类型与限额，不新增端点）。唯一手写来源是 [`contract/models.py`](../contract/models.py)；定案与追认见 [`contract/DECISIONS-2026-11-18.md`](../contract/DECISIONS-2026-11-18.md) 与 [`contract/REVIEW-v0.2.md`](../contract/REVIEW-v0.2.md)。

两种运行模式，切换只改环境变量：`JXL_PROVIDER=fixture`（契约桩，按 `source_id` 返回 fixture，确定性可复现）／`JXL_PROVIDER=model`（多厂家真实视觉模型 + 失败降级）。

## 跑起来

运行依赖有五个：`fastapi`、`uvicorn`、`pydantic`、`httpx`、`Pillow`（**httpx 是运行依赖**，模型适配器直连用它；**Pillow 是运行依赖**，model 路径图片完整解码用它；pytest 仅在 dev extras）。**依赖已精确锁定**：[`requirements.lock`](requirements.lock)（运行）与 [`requirements-dev.lock`](requirements-dev.lock)（运行+测试）钉死全部传递依赖的 `==` 版本，由 `devlog/private-evidence/make_lock.py` 从跑通全量测试的环境生成；`tests/test_packaging.py` 守着「当前环境 == 锁」的漂移守卫。`pyproject.toml` 的 `version` 已与契约对齐为 **0.5.0**。

```bash
cd backend
python -m pip install -r requirements.lock   # 推荐：精确锁，可复现（测试再装 requirements-dev.lock）
# 或 python -m pip install .                 # 下限约束安装（版本可能漂移，不推荐复现场景）
python -m uvicorn app.main:app --port 8000
```

已实证：全新 venv（Python 3.12.3，仅上述运行依赖、无 pytest）启动后 `/api/healthz` 与 `/api/analyze` 均 200，且图片完整解码可用（真实 1x1 放行、仅文件头 PNG 422）。见 devlog 证据 `cleanenv_startup.txt`（第五轮）、`cleanenv_round6.txt`（第六轮）与 `cleanenv_round7.txt`（第七轮：**按 lock 精确安装**后全量测试 + 启动 + 防护/上游上限实证）。锁在 Windows/Python 3.12 环境按 marker 求值生成（含 colorama，跨平台无害；uvloop 等 optional extra 未含）；换平台部署如需 extra 自行补充并重跑全量测试后重新生成锁。

启动日志打印 provider 与可用 `source_ids`；交互式文档 `http://127.0.0.1:8000/docs`。

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/healthz` | 返回 `model_ready` / `api_version` / `schema_version`，驱动前端「AI 暂不可用」态 |
| `POST /api/analyze` | body 为 `AnalyzeRequest`；返回 `AnalyzeResponse` |

**`model_ready` 的语义**：代表「模型配置可装载」（router 能构建、至少一个 profile 有密钥与 base_url），**不代表已验证厂家实时可用**。健康检查**不触发任何付费识别**——只装载配置，不发模型请求。厂家是否真的可用要到第一次 `/api/analyze` 才知道，失败走 503 降级。

### 错误注入（仅桩/测试模式）

```
POST /api/analyze?fail=413   → payload_too_large
POST /api/analyze?fail=422   → model_output_invalid
POST /api/analyze?fail=503   → model_unavailable
```

**只在 `JXL_PROVIDER=fixture` 生效**。生产模型模式（`model`）下带 `?fail` 一律 422 `invalid_request`（「故障注入仅桩模式可用」），外部无法在线上触发降级。三条对应前端必须实现的降级：413 提示压缩重试、422 落 `Note.status=failed` 且保留原图、503 隐藏 AI 入口但保留「仅保存」。

### 请求示例

```bash
curl -X POST http://127.0.0.1:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"source_id":"src-01","kind":"image","image_base64":"<桩:任意非空串>","captured_at":"2026-11-17T09:12:00+08:00"}'
```

桩阶段 `image_base64` 内容不被使用，非空即可；**model 路径则必须是真实 PNG/JPEG/WebP**（见输入校验）。可用 `source_id`：`src-01` 课程通知、`src-02` 评分补充（含相对时间 unresolved）、`src-03` 改期通知、`src-04` 参考资料（text，`kind` 必须为 `text`）。

## 滥用防护（第七轮）

公开模型接口可能被滥用（刷量烧钱、并发拖垮、超大请求）。[`app/guard.py`](app/guard.py) 提供四层防护，**全部进程内存实现，不建库不建表**；只拦 `POST /api/analyze`，**`healthz` 永远开放**（前端降级态探测，不触发模型调用）。拒绝沿用契约 `ApiError` 结构（`code` 本就是开放字符串，契约 0.3.0 字节不变）：

| 机制 | 变量 | 默认 | 拒绝 |
| --- | --- | --- | --- |
| 可选 Bearer 鉴权 | `JXL_API_TOKEN` | 空=关闭 | 401 `unauthorized`（retryable=false） |
| 按 IP 限流（令牌桶匀速回填） | `JXL_RATE_LIMIT_PER_MIN` | 60 | 429 `rate_limited`（retryable=true） |
| 分析并发闸（非阻塞，不排队） | `JXL_MAX_CONCURRENT_ANALYZE` | 4 | 503 `model_unavailable`（现有「仅保存」降级） |
| 每日厂家调用额度（北京时间日界重置） | `JXL_MAX_MODEL_CALLS_PER_DAY` | 1000 | 503 `model_unavailable`（现有降级） |

- **鉴权默认关闭**是为了前端零改动联调；公网部署**必须**设置长随机令牌，前端请求带 `Authorization: Bearer <令牌>`。令牌比较用 `hmac.compare_digest`（防时序侧信道），**令牌绝不进日志**（有回归守着）。
- **额度计数单位是「一次厂家 HTTP 尝试」**（含重试与切换 profile），因为每次尝试都可能计费；没有厂家价格表，不假装换算成钱。耗尽后不再发起任何厂家调用（计数假厂家实证）。桩模式不消耗额度。
- 限流/并发/额度三个变量 **`0` 是显式「关闭」语义**；负数/非整数启动即 `ConfigError`。
- 中间件顺序保证**鉴权/限流拒绝发生在缓冲请求体之前**（Guard 在 BodyLimit 外层）——滥用请求不会先占用内存读完 8MB body（有回归证明 429 先于 413）。
- **对前端的影响**：默认配置下行为不变；新增 401/429 两个状态码属现有错误结构内的新拒绝原因（401 需配置令牌后才会出现，429 提示稍后重试），并发满/额度尽走**现有 503 降级路径**，无需改契约。
- **边界**：单进程内存计数，重启清零、多实例各自计数；反向代理后所有请求同源 IP（不信任 `X-Forwarded-For`），公网大规模部署应换网关层集中限流/鉴权。令牌桶表有界（4096 key，洪水时丢弃最旧条目）。

## 输入校验（调模型之前拒绝）

契约保证值的「形状」；[`app/validation.py`](app/validation.py)、[`app/time_rules.py`](app/time_rules.py) 与 [`app/model/core.py`](app/model/core.py) 补「真实日历/时钟/时区偏移 + 图片完整解码 + 资源上限」，全部在调用模型**之前**完成，沿用现有 `ApiError` 结构：

- **统一时间合法性**：`captured_at`、请求 `reference_at`、节点 `reference_at` / `message_date`、节点/字段值不只查正则，还经 `time_rules` 严格解析。**先显式校验时区偏移（小时 00-23、分钟 00-59）再交 `fromisoformat`**——因为 `fromisoformat` 会把 `+08:75` 静默归一成 `+09:15`、`+08:60` 归一成 `+09:00`，这是「用静默转换掩盖非法输入」。`+08:75`/`+08:60`/`+25:00`、`2026-02-30`、13 月、25 点 → 422 `invalid_request`（节点/字段非法 → 模型输出降级 422）。合法毫秒、闰日、跨年、`Z`、明确偏移一律保留。
- **图片完整解码（仅 model 路径）**：安全拆 data URL（**缺逗号的畸形 data URL → 422，绝不抛 IndexError 成内部错误**）→ 严格 base64（`validate=True`）→ 解码字节上限 → **Pillow `Image.open` 判格式/尺寸（PNG/JPEG/WebP，不认识的内容绝不默认当 PNG）→ 像素/边长上限 → `verify()` + `load()` 完整解码**。**仅文件头、截断、损坏的图片一律 422 拒绝**（旧版只嗅魔数，24 字节仅头 PNG 会漏进模型）。超限 → 413 `payload_too_large`；非法 base64/未知格式/损坏 → 422。损坏/畸形图片在调模型前拒绝，**计数假厂家实证模型调用次数为零**。
- **文字字数上限**、**模型输出大小上限**：超限分别 422 `invalid_request` / 模型输出降级 422。
- **桩占位图片豁免**：fixture 的 `__INJECT_IMAGE_BASE64__` / 测试 marker 不是真实图片，桩模式不做内容校验；**不靠放宽生产校验来兼容测试**。同一 marker 走 model 路径会被 422 拒绝（有回归守着）。

## 分析统一总时限（硬截止，含读取中途）

`JXL_ANALYZE_BUDGET_S`（默认 120s）是**整条分析的统一总预算**：单请求、重试、退避等待、切换 profile、**网络读取**共用同一个绝对 deadline（`time.monotonic()` 基准）。剩余预算不足即停止继续尝试，抛 timeout → 映射现有 503 `model_unavailable` 降级。不引入异步/任务队列。

**读取阶段也是硬截止**：适配器用 `client.stream("POST", …)` 逐块 `iter_bytes()`，每块之间检查 `monotonic() > deadline`，超时即在 `with` 内抛错——**关闭响应、释放连接**，不是「等整段返回后才查超时」。单次 httpx timeout 被钳制为 `min(profile.timeout_s, 剩余预算)`，只发头不发体的静默厂家也被 read timeout 兜底。旧版 httpx read timeout 是「每段间隔」而非总时长，分段慢响应（每 0.05s 一段）会无限拖长——已修复。

已用**真实本地 HTTP 假服务**（`ThreadingHTTPServer` + 真实 socket，非仅 MockTransport）实证：分段慢响应在预算 0.3s 下 **0.337s 终止**（无修复会拖到 ~1.5s）且**厂家侧检测到客户端断开**；静默无响应 **0.311s 终止**并释放连接；预算内慢响应成功；首选失败备用成功。另含假模型回归：预算耗尽提前停止且总等待有界、单请求收到被钳制的绝对截止、API 层映射 503（`tests/test_budget.py`，原始数字见 `devlog/private-evidence/round6_acceptance.txt`）。

### 上游响应字节上限（第七轮）

旧版把上游响应**完整读进内存后**才查输出字符数——恶意/故障厂家可用超大响应耗尽内存。现行 `JXL_MAX_UPSTREAM_BYTES`（默认 4 MiB，正整数）在**流式读取循环内累计字节**，超限立即抛 `invalid_output` 中断读取、关闭响应释放连接（映射现有 422 `model_output_invalid`）；**错误路径同样受限**（≥400 的错误体最多读 64 KiB 即截断，详情只取前 200 字符且脱敏）。已用真实本地假服务实证：2.5 MiB 分段超大响应在上限处中途截断、**厂家侧检测到断开**；超大 500 错误体同样截断并释放连接（`tests/test_upstream_limit.py`）。

## 配置校验（尽早明确报告）

- **模型配置**（`JXL_MODELS`）：profile 名称唯一、协议 ∈ {openai, anthropic, gemini}、`timeout_s`/`retries`/`max_tokens` 的类型与范围、`json_mode` 布尔、`extra_body` 对象、`base_url`/`base_url_env` 二选一**且各自须为非空字符串（拒绝整数/数组/空白串）**。非法在装载期抛 `ModelError(no_profile)`；启动期 lifespan 记 `model_config_error`（不含密钥），`/api/healthz` 报 `model_ready:false`——不等用户发起分析才暴露内部错误。
- **运行配置**：`JXL_PROVIDER` 枚举、各上限/预算为正数且在范围内；**预算拒绝 NaN/Infinity（`math.isfinite`）**；**`JXL_MAX_BODY_BYTES`/`JXL_MAX_UPSTREAM_BYTES` 必须是合法正整数（负数/零/小数/非数字一律 `ConfigError`，绝不静默换回默认值）**；防护三变量（限流/并发/额度）为非负整数，`0`=显式关闭。非法抛 `ConfigError`，启动即失败并给出明确变量名与原因。

## CORS 与错误可读性

中间件顺序（外→内）：**CORS → RequestId → Guard → BodyLimit**。CORS 最外层（最后 `add_middleware`）：中间件直写的 401/429/413 只有经过 CORS 的 send 包装才带跨域头；顺序反了会让允许来源读不到这些错误。已真实 HTTP 实证：修复前 413 无 `Access-Control-Allow-Origin`（跨域不可读），修复后 413/422/503/预检均带该头（`probe_cors_before.txt` / `probe_cors_after.txt`）；第七轮 401/429 同样带跨域头与 request id（有回归）。

**request_id（第七轮）**：`RequestIdMiddleware` 每请求生成 uuid4，经 contextvar 注入**所有** `log_event`（含异常处理器与中间件直写拒绝的日志），并回写 `X-Request-ID` 响应头——200/401/429/413/422/503 全带，日志与响应可按 id 对齐排障。不信任客户端自带的 `X-Request-ID`（可伪造），一律服务端生成。

**请求体不再保留两份**：`BodyLimitMiddleware` 逐条回放原始分片消息给下游，不再自己 `b"".join` 出第二份完整 body（下游解析时自会拼接一份，峰值只有一份完整 body + 分片）。

**脱敏**：422 详情剥掉 pydantic 的 `input`/`ctx`（否则回显整张图片 base64），只留 `loc/msg/type`，msg 再剥长 base64 并限长；厂家错误详情/完整上游异常不进响应也不进日志（`ModelError` 只把 kind 落日志）；未处理异常只记类型名。日志仅元数据（`observability._FORBIDDEN` 兜底）。

## 结构

```
app/
  _contract.py      把仓库根加入 sys.path，直接 import contract.models（不复制契约）
  config.py         os.environ 配置 + ConfigError 早报告（NaN/Inf/正整数/非负整数/类型）
  time_rules.py     统一时间合法性（拒非法偏移）+ 北京时间默认解释（单一来源）
  validation.py     真实日历/偏移 + 图片完整解码（Pillow）+ 文字/输出上限（调模型前拒绝）
  guard.py          滥用防护：可选 Bearer 鉴权 + 按 IP 令牌桶限流 + 并发闸 + 每日厂家调用额度（北京日界）
  errors.py         ApiFault + 全局异常映射（422/413/503/500）+ 中间件直写错误 send_error，422 详情脱敏
  observability.py  脱敏结构化日志，_FORBIDDEN 兜底，request_id contextvar 注入
  providers.py      AnalyzeProvider 协议 + FixtureProvider + ModelProvider + 依赖注入
  api.py            两个 router；?fail 仅桩模式；请求级校验前置
  main.py           create_app()：CORS→RequestId→Guard→BodyLimit、异常处理、lifespan 配置早报告
  model/
    base.py         ModelProfile（不含密钥）+ VisionModel 协议（complete 收绝对 deadline）+ ModelError + 状态码分类
    adapters.py     openai / anthropic / gemini 三协议适配器，httpx 流式直连，读取按绝对截止+字节上限中途终止并释放连接
    core.py         厂家无关：SYSTEM_PROMPT、输出解析、统一参照约束、日历/偏移校验、北京时间选主、输出上限
    registry.py     多 profile 装载与配置校验、统一总预算、失败降级、每次厂家尝试过费用额度闸
requirements.lock / requirements-dev.lock   精确依赖锁（传递闭包 ==，漂移守卫在 test_packaging）
tests/              354 条测试（含日历/偏移/图片完整解码/上限、硬总预算+真实假服务、上游字节上限、滥用防护、request_id、配置校验、北京时间、CORS、脱敏、隐私、打包一致性）
```

**换厂家不改代码**：只改 `JXL_MODELS`。prompt、解析、规范化、契约、前端全都不动。

## 多厂家模型层

`JXL_PROVIDER=model` 启用。配置见 [`.env.example`](.env.example)，要点：

- **`JXL_MODELS` 里只写密钥的环境变量名（`api_key_env`），不写密钥本身**，可入库、可发队友；密钥留在各自 `.env`。
- 缺密钥/缺 base_url 的 profile 自动跳过；按数组顺序或 `JXL_MODEL_ORDER` 依次尝试，失败自动降级。
- 三协议：`openai`（兼容 OpenAI/DeepSeek/Kimi/智谱/通义兼容/硅基流动/OpenRouter/Ollama/vLLM）、`anthropic`、`gemini`。**不引入任何厂家 SDK**。
- 密钥一律走请求头；Gemini 用 `x-goog-api-key` 而非 URL query。
- 降级触发：429 限流、5xx、超时、网络错误、**模型输出不合契约**、**总预算耗尽**。401/403 不重试直接换下一个。
- 全部失败 → 503 `model_unavailable`；全部输出不合契约 → 422 `model_output_invalid`。前端降级路径不变。

### 相对时间与参照（0.3.0，废止旧口径）

**旧版「后端用 `captured_at` 推算相对日期、缺时区用保存时区补」已废止。** 现行：

- 模型负责自然语言→ISO 并标 `basis`（explicit/relative/inferred/superseded）与候选角色/参照；后端做格式/日历/参照边界校验与规范化。
- **统一参照约束**：凡依赖参照的产出（relative 换算、inferred 推算、任何 basis 下的补年份）都必须有可靠参照——消息自身明确日期（`reference_source=message_date` 且 `reference_at==message_date`）或用户指定（`reference_source=user` 且等于请求 `reference_at`）。**`captured_at` 是收集时间，永远不作参照（当天保存也不行）**。无可靠参照 → `value=null`、保留原文、`derived=true` + warning，交用户确认。
- **不自动补时区，但产品默认按北京时间解释**：原文未注明时区的值**保留 naive 形状**（`tz_known=false`，不冒充补时区），另加 `timezone_unspecified` warning 明示「原文未注明时区，产品默认按北京时间 UTC+08:00 解释用于比较/逾期，非原文事实」。**业务计算**（选主比较、逾期判断）由 `time_rules.interpret_instant` 把 naive 按北京时间解释、明确偏移转成同一绝对时刻——**绝不把明确偏移直接替换成 +08:00**（`+09:00` 的 18:00 实际是 09:00 UTC，保留实际含义）。`canonical_datetime()` 只补秒、`Z`→`+00:00`。产品默认时区固定 `UTC+08:00 / Asia/Shanghai`，**不跟随服务器/设备时区**。
- **date-only 截止**：保留 `YYYY-MM-DD`，**不补 23:59**；逾期从**北京时间次日 00:00** 起判（`time_rules.beijing_date_deadline_instant`，跨年/闰日边界正确）。「今天/日期分组/逾期」统一按北京时间日界线计算（前端消费同一规则）。
- `deadline` 由后端仅从 `role=submission_deadline` 且非 superseded 的节点确定性选主：**同精度内按绝对时刻比较**（naive 按北京解释、明确偏移转同一时刻），date 与 datetime 混合精度仍判不可比较 → deadline 缺席交用户选择；活动开始/背景日期/被取代日期不自动成为截止。
- **缺失日期不补今天**：模型未给 `deadline`/`message_date`/`reference_at` 时后端**保持空缺，绝不拿「今天」兜底**。「空日期默认今天」是前端输入体验（保存/确认时生效、可清空/无截止），不在后端自动填充；只有用户显式采纳今天为参照（请求 `reference_at`）才按用户参照处理，不冒充消息原始日期。`captured_at`/`analyzed_at` 保持合法 UTC 时间戳，收集时间 ≠ 消息发布时间。

> `fixtures/*.json` 的 `expected_analysis` 是**后端最终输出**（已含规范化），不是模型原始输出。

### 两个环境坑

1. **`NO_PROXY` 含 `[::1]` 会让 httpx 崩**（把条目当 URL 解析抛 InvalidURL）。模型调用一律 `trust_env=False`；需代理显式设 `JXL_HTTPS_PROXY`。`test_ambient_no_proxy_does_not_break_real_client` 守着（必须走真实 client 构造）。
2. **图片格式与完整性由 Pillow 完整解码裁决**（`open` 判格式/尺寸 → `verify` + `load` 解码像素），兼容前端 data URL；未知格式/仅文件头/截断/损坏一律拒绝而非默认 PNG。畸形 data URL（缺逗号）安全返回 422，不抛 IndexError。

## 配置

### 本机个人空间联调

本机开发预览使用 `http://127.0.0.1:5174/#/assistant`。个人空间先将截图保存在浏览器，点击生成或提取时再调用模型。演示空间在同一地址播放内置课程案例。

个人空间右上角的「连接千问」使用北京地域的阿里云百炼按量付费 API Key。验证仅查询模型目录。提取文字和生成计划使用 `qwen-plus`，提取截图使用 `qwen-vl-plus`。当前标签页只在内存里保留密钥，刷新、切换空间或断开连接后需重新输入。

对外部署请使用 HTTPS，同源网关转发 `POST /api/qwen/verify`、`/api/qwen/analyze` 和 `/api/qwen/propose`，保留 `X-JXL-Qwen-Key` 请求头，并在网关端注入已有的服务访问令牌。日志应排除该密钥头。这三条路由仅使用当前请求提供的密钥。

本机的 `backend/.env.development.local` 保存 `JXL_PROVIDER=model`、模型配置、`JXL_DEV_BACKEND=http://127.0.0.1:8016` 和本地代理令牌。模型密钥由运行后端的环境提供。重新开机后，在 `backend` 目录运行以下命令，然后在 `frontend` 目录运行 `npm run dev -- --host 127.0.0.1`。修改联调配置后重启两个服务。

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8016 --env-file .env.development.local
```

### 后端环境变量

复制 `.env.example` 为 `.env`（**`.env` 已在根 `.gitignore`，绝不入库**）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JXL_PROVIDER` | `fixture` | `fixture`（桩）/ `model`（真实模型）；其它值启动即 ConfigError |
| `JXL_MAX_BODY_BYTES` | `8388608` | 请求体上限；Content-Length 与 chunked 都拦 |
| `JXL_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许来源 |
| `JXL_MAX_TEXT_CHARS` | `20000` | 文字字数上限 |
| `JXL_MAX_IMAGE_BYTES` | `6291456` | 图片解码后字节上限 |
| `JXL_MAX_IMAGE_PIXELS` | `40000000` | 图片像素上限 |
| `JXL_MAX_IMAGE_SIDE` | `10000` | 图片单边上限 |
| `JXL_MAX_OUTPUT_CHARS` | `200000` | 模型输出大小上限 |
| `JXL_ANALYZE_BUDGET_S` | `120` | 整条分析统一总预算（含重试/退避/切换/网络读取） |
| `JXL_MAX_UPSTREAM_BYTES` | `4194304` | 上游响应字节上限（4 MiB），流式读取中途超限即截断释放连接；正整数 |
| `JXL_API_TOKEN` | 空 | 可选 Bearer 令牌；空=关闭鉴权（本地联调），公网部署必须设置 |
| `JXL_RATE_LIMIT_PER_MIN` | `60` | 每 IP 每分钟分析次数（令牌桶）；0=显式关闭 |
| `JXL_MAX_CONCURRENT_ANALYZE` | `4` | 分析并发上限，满则 503 降级不排队；0=显式关闭 |
| `JXL_MAX_MODEL_CALLS_PER_DAY` | `1000` | 每日厂家 HTTP 尝试额度（含重试/切换），北京日界重置；0=显式关闭 |
| `JXL_MODELS` | 空 | profile 数组；只含密钥的环境变量名 |
| `JXL_MODEL_ORDER` | 空 | 显式尝试顺序 |
| `JXL_HTTPS_PROXY` | 空 | 显式代理；不读系统代理环境变量 |

体积校验由纯 ASGI `BodyLimitMiddleware` 完成（Content-Length 快拒 + chunked 实读上限，**逐条回放原始分片、不额外 join 第二份完整 body**），Guard 在其外层（滥用拒绝先于缓冲），CORS 在最外层保证 401/429/413 跨域可读。不能从 receive 抛异常（会被吞成 400），也不能用 `@app.middleware("http")` 改 `request._receive`（call_next 读原始 receive）。

## 测试

```bash
cd backend
python -m pytest
```

**354 条**，分组：

- `test_api.py` — 契约符合性、无 confirmed、candidate 必带 quote、相对时间 unresolved+derived、missing 为 null、刻意保留的识别错误、确定性、422/413/503、**?fail 生产关闭**、**CORS 413/422/503 可读**。
- `test_validation.py` — **真实日历/非法时区偏移**（请求/节点参照）、base64/未知格式/字节/像素/边长上限、**图片完整解码（仅头/截断/损坏 PNG/JPEG/WebP 拒绝、畸形 data URL 422）**、文字与输出上限、**非法输入零模型调用（计数假厂家）**、桩占位豁免。
- `test_time_rules.py` — **统一时间合法性**（`+08:75`/`+08:60`/`+25:00` 拒绝、合法毫秒/闰日/跨年/明确偏移保留）+ **北京时间解释**（naive→北京、明确偏移转同一时刻不替换、date 逾期次日 00:00 跨年/闰日边界）。
- `test_budget.py` — **统一总预算**：慢响应/首选失败备用成功/全部失败/预算耗尽有界/绝对截止钳制/API 映射 503（假模型）+ **真实本地 HTTP 假服务**（分段慢响应中途终止并释放连接、静默无响应终止、预算内成功、首选失败备用成功、**超大响应字节截断**）。
- `test_upstream_limit.py` — **上游字节上限**：超限成功体在 JSON 解析前拒绝、API 映射 422、错误体截断且状态码仍正确分类、密钥脱敏、**真实假服务证明中途截断并释放连接**。
- `test_guard.py` — **滥用防护**：鉴权默认关/开启后 401/healthz 开放/令牌不进日志、限流 429/按 IP 隔离/0 关闭/匀速回填/桶表有界、**429 先于 413（拒绝在缓冲前）**、并发闸非阻塞/满则 503/释放后恢复、每日额度计数/耗尽/**北京日界重置（UTC 日界未翻篇也重置）**/重试也计费/耗尽零厂家调用/桩不消耗。
- `test_request_id.py` — **request_id**：200/401/429/413/422/503 全带 `X-Request-ID`、每请求唯一、日志与响应头对齐、不信任客户端伪造 id、**分片 body 原样回放**（chunked 正常/超限 413）。
- `test_packaging.py` — **打包一致性**：pyproject 版本==契约 0.5.0、锁文件精确 `==` 且覆盖运行依赖、dev 锁是超集、**当前环境版本==锁（漂移守卫）**。
- `test_config.py` — 名称唯一/协议/类型范围/`base_url` 类型非空/运行配置早报告/**NaN/Inf 拒绝**/**body 与上游上限正整数**/**防护变量非负整数、0=显式关闭、默认值**。
- `test_privacy.py` — 422 不回显 image/原文、详情只 loc/msg/type、日志脱敏。
- `test_model_adapters.py` — 三协议请求形状、密钥走头、状态码映射、厂家消息脱敏、超时/非 JSON、NO_PROXY 回归。
- `test_model_core.py` — 参照约束/补年/跨年、日历/**非法偏移拒绝**、**北京时间选主（naive 与明确偏移可比、偏移不替换）**、**缺失日期不补今天**、Markdown 剥离、missing 归零、quote 回退、拒绝 confirmed/非法类型。
- `test_model_registry.py` — 配置装载、缺密钥跳过、降级、retries、输出不合契约降级、API 映射、healthz、**上游详情不回显**。

**测试与运行环境解耦（停滞根因修复）**：`conftest.client` 与 `test_api.small_limit_app` 现在**强制 `JXL_PROVIDER=fixture`**；autouse fixture 每用例清零进程级每日额度单例，避免跨用例累计。此前它们继承 ambient provider——在 `JXL_PROVIDER=model` 的评审环境里，test_api 每条 analyze 用例都真调付费模型 → 整组 API 测试停滞（本机 ambient 为 fixture 故曾「不可复现」）。已用本地假厂家复现该机制并证明修复：旧式 `create_app()` 在 ambient=model 下命中假厂家（慢），新 conftest 下 pytest 假厂家**零调用**且快（`repro_api_stall.py` / `api_stall_repro.txt`）。**不靠跳过关键用例换通过**。

全部模型测试用 `httpx.MockTransport`/假 adapter，**不联网、不需要真密钥**。契约层另有 `contract/selftest.py` **34 条负向守卫**，证明守卫不是恒真。

隐私测试不是形式：FastAPI 默认 422 会把请求 `input` 原样回显（含整张图片 base64），`errors._safe_errors()` 剥掉它，`test_422_does_not_echo_image_base64` 守着。

## 已知边界

- 桩不缓存分析结果、不记 `source_id` 历史；后端无副作用，幂等由前端 `source_id` 保证。
- `FixtureProvider` 启动时一次性读 fixture，改 fixture 需重启。
- `ModelProvider` router 懒构建 + 启动期配置校验：没配 `JXL_MODELS` 服务仍启动，`healthz` 报 `model_ready:false`，前端降级「仅保存」。
- 总预算是**硬截止**：尝试间检查 + 单请求 timeout 钳制 + **流式读取逐块检查绝对 deadline，超时中途终止并释放连接**。单个厂家调用最长不超过剩余预算。未引入异步/队列。
- **节点/字段值不支持毫秒**：契约 `DEADLINE_VALUE_RE` 形状不含小数秒（本轮契约保持字节不变），带毫秒的节点/deadline 值会被置空待确认；毫秒仅在 `captured_at`（请求级）与 `time_rules` 解析层保留。如需节点级毫秒须改契约（不在本轮范围）。
- 模型层曾用真实密钥+真实厂家验证（DashScope `qwen3.8-flash`，图片/文字双模态 HTTP 200 且契约通过）；思考模型需 `extra_body:{"enable_thinking":false}` 关思考。
- 解析守卫：模型给 `candidate` 却无值时降级 `missing` + `candidate_without_value` warning，不静默吞掉。
- **防护是单进程内存态**：限流/并发/额度重启清零、多实例各自计数；反向代理后按网关 IP 计（不信任 `X-Forwarded-For`）。公网大规模部署应换网关层集中防护；本轮不引入 Redis/数据库（PRD 不建库约束）。
- **401/429 是新增 HTTP 状态**（错误结构不变）：默认配置下不会出现（鉴权关、限流宽松）；前端若启用令牌需带 `Authorization` 头，429 按「稍后重试」提示。并发满/额度尽复用现有 503 降级，前端零改动。
- **依赖锁按生成平台求值 marker**（Windows/Py3.12）：换平台如需 optional extra（uvloop 等）自行补充并重跑全量测试后重新生成；`test_installed_runtime_versions_match_lock` 只守五个运行根依赖。
- **时区文档口径已统一为北京时间**（第七轮修正 `core.py` docstring 与 HANDOFF 残留的「按用户本地时区解析」）；`lab/src/App.vue` 的 naive 比较仍用设备本地时区，属前端遗留交接项（本轮不改前端）。
