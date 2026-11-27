# 前端交接说明 · 契约 0.4.0

> 交接日期：2026-11-17（2026-11-18 返工修订；2026-11-20 契约升 0.4.0）｜后端负责人整理｜**先读这一份，再翻其它文件**
> 契约版本 **0.4.0**（`schema_version 0.4.0`，API 路径 v1）：键集合/值类型/节点角色/参照为机器约束，越界即 422。定案与追认见包内 `contract/DECISIONS-2026-11-18.md` 与 `REVIEW-v0.2.md`；**前端实际签收仍待办**。
> **2026-11-18 返工已修（后端 + lab 实证）**：① 写库先脱代理深克隆、保存失败界面不变且编辑框不关；② derived+confirmed 放行（保留推算来源）；③ 用户参照 reference_at 注入模型提示词；④ 保存日永不作相对时间参照（当天也不行）；⑤ 模型只给 deadline 也合成节点走选主/参照规则；⑥ 带时区截止按绝对时刻比较。另：TimeNode 已导出、删除便签解除任务关联、手动/节点日期日历校验、节点编辑器补齐 role/参照字段。
> **2026-11-18 第三轮返工已修（5 项遗留，后端 + lab 实证）**：① 含数字的相对表述（「明天下午5点」）也识别为相对，无可靠参照不换算；合成节点 role=unknown，活动开始不会被当作提交截止（提示词补节点示例后真模型输出带角色节点）；② 删除便签+解除任务关联改为**同一 IDB 事务**，失败整体回滚不留悬空引用；③ 连续快速确认按便签串行化保存，不丢修改；④ **确认不改值来源**：derived+confirmed 保留 origin=model（第二轮「须 origin=user」口径废止），用户实际改值才 origin=user；⑤ 跨年相对日期合法保留（12-31「明天」→次年 01-01）。golden 13 份已用新提示词对真模型重录并回归 13/13；133 单测 / 27 负向 / 5 fixture。
> **2026-11-18 第四轮返工已修（inferred 参照漏洞 + 4 项待办，后端 + lab 实证）**：① **统一参照约束**：basis=relative/inferred、或任何 basis 下补年（value 年份不在原文）一律须可靠参照（message_date 自洽 / 用户 reference_at），否则 value=null、raw 保留——「11月20日」「三天后」无参照不再接受模型补年；有参照时跨年仍合法；② 分析保存失败暂存结果，重试仅落库**不重调模型**；③ 写库快照递归脱代理（嵌套 reactive 不再 DataCloneError）；④ schema 机器关联：Field if/then 约束 key=time_nodes 的 value 为 TimeNode[] 或 null（运行时 + 生成 schema 双重校验）；⑤ 非法 UTC 偏移（+99:99）lab 与契约均拒绝。148 单测 / 34 负向 / 5 fixture / golden 13/13 / 真模型 6 组对照。
> **2026-11-18 产品前端第一轮闭环已交付（`frontend/`，真浏览器验证）**：收集 → 核对 → 建任务 → 刷新恢复已在 `frontend/` 实现，并经 playwright-core + 系统 Edge 42 项断言验证（360/768/1440 无横向滚动、真模型、422/413/503/网络降级、保存失败注入仅重试落库、刷新与深链接恢复、幂等重分析不丢人工事实）。`lab/` 仍为接口联调台，**不是产品 UI**。开工基线见 `devlog/coordination/产品前端开工约束.md`，选定布局「核对工作台」见 `handoff/ui-reference/`。**前端实际签收仍待办（不代签）**；F13 规划/备份恢复/示例隔离/专注等剩余 P0 未做。
> **2026-11-18 后端加固第五轮已修（仅后端 + 测试 + 文档，契约 0.3.0 / 接口路径 / 响应结构不变，前端零改动）**：① 输入真校验——日历非法（如 `reference_at=2026-02-30`）、Base64 非法、**不认识的图片格式不再默认 PNG**、文字/图片字节/像素/单边/模型输出超限，均在**调用模型前**按现有 422/413 拒绝；② httpx 移入运行依赖，干净环境仅装 runtime deps 即可启动；模型配置（名称唯一/协议/超时/重试/输出长度）装载期校验并报 `model_config_error`；③ 分析统一总预算 `JXL_ANALYZE_BUDGET_S`（单请求+重试+退避+切换共用 deadline），耗尽走**现有 503 降级**；④ **`?fail=413/422/503` 仅桩模式可用，生产模型模式返回 422**——前端对生产后端联调不能再用 ?fail 注入；CORS 修为最外层，**413 跨域可读**（实证 before=False→after=True）；错误/日志不回显图片/原文/密钥/上游异常；⑤ README 更新 0.3.0，删废止口径，**`model_ready` = 配置可装载，非已验证厂家实时可用**，healthz 不触发付费识别。**对前端消费的影响均为现有错误结构内的新增拒绝原因（413 多了像素/单边超限、422 多了非法日历/未知格式/文字超长），降级路径不变，无需改契约或前端代码。** 209 单测 / 34 负向 / 5 fixture / golden 13/13；证据见 `devlog/private-evidence/`（probe_cors_before/after、prod_fail_inject、cleanenv_startup、api_stall_repro、regress_backend_round5）。**未提交/未推送/未发布，交回审查。**
> **2026-11-18 后端加固第六轮已修（仅后端 + 测试 + 文档，契约 0.3.0 / 接口路径 / 响应结构不变，前端零改动）**：① **真正的分析总时限（硬截止）**——流式读取逐块检查绝对 deadline，分段慢响应/静默无响应在预算内**中途终止并释放连接**（真实本地 HTTP 假服务实证：0.3s 预算下 0.337s/0.311s 终止、厂家检测到断开；旧版会拖到 ~1.5s），耗尽走现有 503；② **图片完整解码**——新增运行依赖 **Pillow**，仅文件头/截断/损坏 PNG/JPEG/WebP 一律 422（旧版 24 字节仅头 PNG 漏进模型），**畸形 data URL（缺逗号）→422 不抛 IndexError**，计数假厂家证非法图片**零模型调用**；③ **统一时间合法性**——新增 `app/time_rules.py`，先显式校验时区偏移再解析，拒绝 `+08:75`/`+08:60`/`+25:00`（`fromisoformat` 会静默归一），请求/节点/deadline 三层一致，合法毫秒/闰日/跨年/明确偏移保留；④ **配置校验补齐**——预算拒 NaN/Infinity、body 上限须合法正整数（不静默换默认）、`base_url`/`base_url_env` 类型与非空，装载期明确报错。**⑤ 默认时区统一北京时间（UTC+08:00 / Asia/Shanghai，不跟随服务器/设备）**：naive 值在**业务计算**（选主比较/逾期）按北京解释、明确偏移转同一绝对时刻（**绝不替换成 +08:00**）；**value 仍保留原文 naive 形状不冒充补时区**，`timezone_unspecified` warning 明示「产品默认北京解释，非原文事实」；date-only 逾期从北京次日 00:00 起判（不补 23:59，跨年/闰日正确）。**⑥ 缺失日期不补今天**：后端不自动填充模型缺失的 deadline/message_date/reference_at，「空日期默认今天」是前端保存/确认时的输入体验（本轮不做、不改前端、无新端点）。**对前端消费的影响：422 多了非法时区偏移/损坏图片/畸形 data URL 拒绝原因，降级路径不变；选主比较改为北京绝对时刻（naive 与明确偏移可比），deadline 值形状不变；无需改契约或前端代码。** 292 单测 / 34 负向 / 5 fixture / golden 13/13 / 干净环境含 Pillow 启动 200；证据见 `devlog/private-evidence/`（round6_acceptance、round6_pytest、cleanenv_round6）。**未提交/未推送/未发布，交回审查。**
> **2026-11-18 后端加固第七轮已修（仅后端 + 测试 + 文档，契约 0.3.0 / 接口路径 / 响应结构不变，前端零改动）**：① **滥用防护**——新增 `app/guard.py`：可选 Bearer 鉴权 `JXL_API_TOKEN`（默认关，公网部署必须开）、按 IP 限流（默认 60/min，429 `rate_limited`）、分析并发闸（默认 4，满则**现有 503 降级**不排队）、每日厂家调用额度（默认 1000 次尝试含重试/切换，**北京时间日界**重置，耗尽走现有 503）；只拦 analyze，healthz 永远开放；拒绝发生在缓冲请求体之前；令牌不进日志。② **上游响应字节上限** `JXL_MAX_UPSTREAM_BYTES`（默认 4MiB）——流式读取中途超限即截断并释放连接（旧版先完整读进内存再查字符数），错误体同样受限（≤64KiB）；真实假服务实证 2.5MiB 分段响应中途截断、厂家检测到断开。③ **依赖精确锁定**——`requirements.lock`/`requirements-dev.lock`（传递闭包 `==`，漂移守卫测试），`pyproject` 版本 0.1.0→**0.3.0** 与契约对齐；干净 venv 按 lock 安装后全量测试+启动实证。④ **时区文档口径统一**——`core.py` docstring 与 HANDOFF 残留的「按用户本地时区解析」全部改为北京时间产品默认规则（解释层，非原文事实）；提示词未动，golden 无需重录。⑤ **请求体不再双份 + request_id**——BodyLimit 逐条回放原始分片不再 join 第二份完整 body；每请求 uuid4 经 contextvar 注入所有日志并回写 `X-Request-ID`（200/401/429/413/422/503 全带）。⑥ `.gitignore` 排除 `*.egg-info/`、`build/` 构建产物。**对前端消费的影响：默认配置行为不变；新增 401/429 属现有 ApiError 结构内的新拒绝原因（启用令牌后才需带 Authorization 头，429 提示稍后重试），并发满/额度尽复用现有 503「仅保存」降级；所有响应多一个 X-Request-ID 头可用于排障报障。无需改契约或前端代码。** 354 单测 / 34 负向 / 5 fixture / golden 13/13 / 干净环境按 lock 安装实证；证据见 `devlog/private-evidence/`（round7_pytest、round7_acceptance、cleanenv_round7、round7_contract_selftest、round7_contract_check、round7_golden）。**未提交/未推送/未发布，交回审查。**
> **2026-11-20 阶段 3B-0 契约升 0.4.0（仅契约 + 生成物 + fixture + 测试 + 后端版本同步，无新端点，前端产品代码零改动）**：FocusSession 新增可选字段 `record_version`（0=旧记录/1=新会话，分版本校验）、`timer_anchor_at`（运行计时锚点）、`task_snapshot`/`action_snapshot`（开始时冻结，不随改名重写）、`task_ref_state`/`action_ref_state`（active/deleted 逐引用标记，deleted 后 id 只是历史标识）；PlanItem 新增 `task_ref_state`（planned 不得指向已删任务），`focus_session_id` 明确为最近一次**已结束**会话快捷引用。**0.3.0 合法的旧记录全部仍合法**（v0 校验规则未变、新字段缺省即旧形态）；v1 新记录校验收紧（快照/引用状态/锚点/ended_at-outcome 成对）。新增 fixture 06–10（契约兼容专用，不进演示 storyline）。方案与规则差异见 `devlog/coordination/2026-11-20-阶段3B-0契约0.4.0兼容方案.md`。393 后端测试（含 39 条新兼容用例）/ 56 负向+8 正向 selftest / 10 fixture / 前端 185 测试+check+build 重跑全绿；healthz 0.4.0 已在临时实例实测。**用户自己的 8000 进程未触碰，需自行重启才报 0.4.0。未提交/未推送/未发布，3B-0 暂停交回审查。**
> **2026-11-20 夜 3B-0 复审整改（C1/C2 两项 P2 守卫，仍 0.4.0，无字段增删改，前端产品代码零改动）**：① **跨记录归属**——check_fixtures 不再只查 ID 存在：Action↔Task 同工作区；active Focus 的 task/action 同工作区且 action.task_id==focus.task_id；focus.plan_item_id 同工作区同任务；PlanItem 快捷会话同工作区、同任务、已结束且**反向关联本条目**（双向闭合）；deleted 历史标识规则不变。② **事件时间真实性**——v1 的 started_at/ended_at/timer_anchor_at、快照 captured_at、TaskSnapshot.deadline_value 全部做真实日历/时刻/偏移校验（显式偏移范围检查，fromisoformat 会静默接受 +08:75）；naive 按产品默认北京时间解释，不依赖设备时区；**v0 旧时间字段不收紧**。fixture 07 补上 focus-v1e.plan_item_id="plan-v1e"（闭合）。复审 7 个负向反例原样重放全部被拒。当前门禁：**423 后端测试 / 71 负向+14 正向 selftest / 10 fixture / 前端 185+check+build 全绿（产物哈希不变）**。三层校验边界（schema/validator/跨记录）见方案 §11。**未提交/未推送/未发布，继续暂停在 3B-0 待复审，不进 3B-1。**
> 结论：**你现在就可以完全脱离后端开工。** 5 份 fixture 可直接当 mock 响应和演示数据。

---

## 1. 包里有什么

| 路径 | 用途 | 你要不要读 |
| --- | --- | --- |
| `HANDOFF.md` | 本文件 | 必读 |
| `contract/README.md` | 端点表、错误语义、幂等、状态机、相对时间约定 | 必读 |
| `contract/typedefs.d.ts` | 类型声明（生成物） | 直接用，不必读 |
| `contract/schema.json` | 机器可读契约，44 个定义 | 需要时查 |
| `contract/models.py` | **契约的唯一手写来源** | 不必读；有争议时以它为准 |
| `contract/generate.py`、`selftest.py` | 后端的生成与自测工具 | 不必读 |
| `fixtures/*.json`、`index.json` | 5 份演示共用数据 + 5 份 0.4.0 契约兼容 fixture（06–10，不进演示） | 必读 `index.json` |
| `fixtures/assets/README.md` | 3 张演示截图的生成方案与脱敏要求 | 若你认领截图则读 |
| `architecture/*.canvas.tsx` | 架构与领域模型评审基线（Qoder Canvas 打开） | 建议看，尤其第二节实体图与第五节排程 |
| `PRD/*.md` | 需求评审定案版 v0.3 | 必读第 4、6、9 章与定案附录 |
| `devlog/README.md` | 比赛要求的每日记录规范 | 必读，你也要记 |
| `devlog/2026-11-17.md` | 后端第 1 天日志，可当格式范例 | 参考 |
| `devlog/2026-11-18.md` | 后端第 2 天日志（第四轮返工 + 产品前端节 18 + 后端加固节 19/20/21） | 参考 |
| `frontend/` | **产品前端工程**：第一轮闭环（Vue3+Vite+Tailwind4+shadcn-vue+Router hash+Pinia+IDB） | 必读 `src/stores/app.js`、`src/services/`；`npm i && npm run dev` 可跑 |
| `devlog/coordination/产品前端开工约束.md` | 产品前端开工基线（技术栈/目录/契约/验收门槛） | 必读 |
| `handoff/ui-reference/` | 选定布局「核对工作台」参考草案（非产品实现） | 建议看 |

---

## 2. 四条必须遵守的约定

这几条光看代码看不出来，但违反了会在联调时炸：

1. **`planner.js` 归你。** F13 P0 的按天排程是**前端纯函数**，必须离线可用。后端只做 P1 的自然语言解析、智能估时、逾期重排。别等后端给排程接口，P0 没有这个接口。
2. **`source_id` 由你生成**（客户端 UUID），它是后端的幂等键。上传成功但分析超时后重试，只带同一个 `source_id`；后端不会、也不应该产生第二份资料。
3. **所有本地存储 key 前缀 `${workspace_id}:`。** 演示空间用独立 id、退出即清，避免覆盖用户真实数据（PRD 决策项 8）。
4. **原图先落盘，再调 AI。** `POST /api/analyze` 之前必须已经写入 IndexedDB。AI 失败绝不能导致原图丢失（PRD F01 第 137 行）。

---

## 3. 三条降级路径（必须实现，不是可选）

| 后端返回 | 你的行为 |
| --- | --- |
| `422` 模型输出不合 schema / 请求非法 | `Note.status = failed`，**原图保留**，提供「重试分析」与「手动整理」 |
| `503` 模型不可用 | 隐藏「AI 整理」入口，**保留「仅保存」**；F09 手动填写行动仍能开始专注 |
| `413` 图片超体积上限 | 提示压缩后重试；原图已在本地，不丢 |

`GET /api/healthz` 返回 `model_ready`，用它驱动全站的「AI 暂不可用」态。断网时除了 `/analyze`，其余功能全部照常。

---

## 4. 接线方式（Vue 3 + JavaScript）

组件体系（2026-11-17 评审定案）：**Tailwind CSS v4 + shadcn-vue（Reka UI）**，组件源码复制进项目、完全可控。仓库内 `lab/` 是接口联调台示例（非产品 UI），可参考其 `src/components/ui/` 与 `src/lib/` 的写法；产品 UI 可用 `npx shadcn-vue add <component>` 继续加组件。

**产品前端工程已建在 `frontend/`（2026-11-18，第一轮闭环已真浏览器验证）**：

```bash
cd frontend && npm install && npm run dev   # 端口 5174，proxy /api → 127.0.0.1:8000
npm run check   # vue-tsc --noEmit -p jsconfig.json（checkJs）
npm test        # vitest + fake-indexeddb（存储/时间/确认/事务规则）
npm run build   # vite build
```

- IndexedDB 用独立 DB `jxl-product`（**不与 lab `jxl-lab` 混**），读写限定 `workspace_id=personal`；演示空间后续用独立 id。
- 路由 **hash 模式**（托管未验证 history 回退前不改）；深链接 `/notes/:id` 刷新可恢复。
- 状态：Pinia 管跨页选择/任务/专注；**IndexedDB 才是事实源**，localStorage 只存 UI 状态与 pendingSave 暂存。
- 你接手后在 `frontend/` 继续剩余 P0（F13 规划/备份恢复/示例隔离/专注），**不要回退把 lab 当产品**。

`jsconfig.json`：

```jsonc
{
  "compilerOptions": {
    "checkJs": true,
    "strict": true,
    "paths": { "@contract/*": ["../contract/*"] }
  },
  "include": ["src/**/*.js", "src/**/*.vue", "../contract/typedefs.d.ts"]
}
```

在 JS 里引用类型（`typedefs.d.ts` 不参与构建，只供编辑器与 CI 校验）：

```js
/** @typedef {import('../contract/typedefs.d.ts').AnalyzeResponse} AnalyzeResponse */
/** @typedef {import('../contract/typedefs.d.ts').Field} Field */

/**
 * @param {string} sourceId
 * @param {string} imageBase64
 * @param {string} capturedAt
 * @param {string} [referenceAt] 用户指定的相对时间参照日期 YYYY-MM-DD（可选）
 * @returns {Promise<AnalyzeResponse>}
 */
export async function analyze(sourceId, imageBase64, capturedAt, referenceAt) {
  const body = { source_id: sourceId, kind: 'image', image_base64: imageBase64, captured_at: capturedAt }
  if (referenceAt) body.reference_at = referenceAt
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw Object.assign(new Error('analyze failed'), { status: res.status })
  return res.json()
}
```

`vite.config.js`：

```js
server: {
  proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } }
}
```

**注意请求体上限**：截图 base64 单张可达数 MB，Vite proxy 与后端都要放开限制，否则表现为莫名的 413。

**后端契约桩服务已可用**（`backend/`，详见 `backend/README.md`）：

```bash
cd backend && python -m uvicorn app.main:app --reload --port 8000
```

- `GET /api/healthz` → `model_ready`，用它驱动全站「AI 暂不可用」态。
- `POST /api/analyze` → 按 `source_id` 返回对应 fixture 的 `expected_analysis`。可用 id：`src-01`（课程通知）、`src-02`（评分补充，含相对时间 unresolved）、`src-03`（改期通知）、`src-04`（参考资料，`kind` 必须为 `text`）。桩阶段 `image_base64` 非空即可，内容不被使用。
- **错误注入供你测三条降级路径**：`POST /api/analyze?fail=413` / `?fail=422` / `?fail=503`。仅桩服务有效。
- CORS 已放行 `http://localhost:5173` 与 `http://127.0.0.1:5173`；请求体上限默认 8 MB。
- 交互文档 `http://127.0.0.1:8000/docs`。

后端换真实模型时只替换 provider，**router、契约、你的代码全都不动**。在那之前你也可以直接用 fixture 当 mock，两者响应完全一致。

---

## 5. fixture 怎么用（前端视角）

每份 fixture 有多个部分，你只取需要的：

- **`expected_analysis`** → 你的 mock `/analyze` 原样返回它。确定性、可复现。
- **`confirmed_note` / `matter` / `task` / `action` / `focus_session` / `plan_items` / `change_proposal`** → F12 演示空间的初始数据，直接灌进 IndexedDB，`is_demo: true`，界面必须标注「演示数据」。
- `source` / `analyze_request` → 后端测试用，你基本不碰。`image_base64` 是占位符 `__INJECT_IMAGE_BASE64__`，忽略它。

`index.json` 里的 `story_order` 是建议的演示叙事顺序：01 通知 → 02 评分补充 → 04 参考资料 → 05 任务与专注 → 03 改期候选。

**键集合按类型封闭（0.3.0 机器约束，越界即 422）**：通用键 `title, deadline`；notice 另加 `requirement, constraints, submit_to, reminder, time_nodes`；tutorial 另加 `summary, steps, cautions`；reference 另加 `summary, keywords`。

**多时间节点（0.3.0）**：notice 的 `time_nodes` 为节点数组 `{label, raw, value, precision, tz_known, basis, role, reference_at, reference_source, message_date, derived}`（`TimeNode` 已在 typedefs 导出）。`role` ∈ submission_deadline/event_start/event_end/other/unknown；`basis` ∈ explicit/relative/inferred/superseded；`reference_source` ∈ message_date/user（**没有 captured**）。**`deadline` 由后端仅从 submission_deadline 且非 superseded 节点选主**；活动开始/补班/背景日期/被取代日期**不**自动成为截止；无有效截止或不可比较时 deadline 缺席、节点保留交用户选择。选主在可比候选内取最早：带时区时刻按**绝对时刻**比较（不同 UTC 偏移不能按字符串排序），精度/时区不一致的候选不可比较 → `deadline_unselectable`。模型只给 deadline 不给 time_nodes 时，后端会合成节点走同一套规则，前端无需特判。前端渲染全部节点并按角色标注，提供「选节点建任务」入口（把活动开始用作截止是用户选择，需明示）。

**value 可能是字符串或字符串数组**（`constraints` / `steps` / `cautions` 常见数组），UI 需两种都渲染。

仍建议遍历 `fields` 通用渲染、对未知键降级显示而非崩溃：prompt 不是机器约束，模型仍可能越界；键枚举/角色/参照的硬保证在契约 0.3.0。

**确认与来源（0.3.0，第三轮修订）**：实际带入任务的关键事实独立确认，整体「已审阅」不能替代；缺失值（value=null）不能点确认为事实；用户确认推算值时保留 `derived=true` 与原文引用，**且不改变值来源 `origin`（仍可为 model）**——确认≠改值，只有用户实际编辑值才标 `origin=user`（契约允许 derived+confirmed 任意 origin，但值必须非空，否则 422）。任务截止可来自便签（`source=note`+`from_note_id`）或用户手动（`source=manual`，不伪造便签），两者都记 `confirmed_at`；手动日期必须日历合法（2月30、25点这类形状合法但日历非法的值要拒绝）；任务可以无截止。行动/计划条目完成不自动完成任务。

**时间比较（0.3.0，第六/七轮统一口径）**：产品默认时区为**北京时间 UTC+08:00（Asia/Shanghai）**，不跟随服务器/设备时区。date 型当天不判逾期，自**北京时间次日 00:00** 起算（不补 23:59）；带时区时刻按实际时间点比较（换算到同一时刻，绝不把偏移改写成 +08:00）；未知时区 naive 值**保留原文形状**，按产品默认北京时间解释用于比较与逾期判断——这是产品默认而非原文事实（`timezone_unspecified` warning 明示），不得仅按字符串排序混合时区。「今天」/日期分组/规划一律用北京时间的日界。

**可靠性（C01）**：写 IndexedDB 前必须脱响应式代理再深克隆（`structuredClone(toRaw(doc))`），否则 Vue Proxy 触发 DataCloneError；所有本地写库失败必须明示、不伪成功——**失败时界面保持原样、编辑框不关闭**，成功才更新 UI。删除被 Task.deadline 引用的便签先阻止并列出受影响任务；删除其余便签要解除各任务 `note_ids` 里的关联，不留悬空引用。

**三个刻意安排的反例，不要当成数据错误去「修好」：**

| fixture | 现象 | 为什么故意这样 |
| --- | --- | --- |
| 01 | AI 把「3000字」识别成「300字」，`confirmed_note` 里该字段 `origin: user` | 演示黄金路径第 3 步「用户修改一项识别错误」 |
| 02 | 便签整体 `reviewed`，但 `deadline` 仍 `unresolved` | 证明字段状态与便签状态不能互相替代（PRD 第 190 行） |
| 05 | 任务截止时间仍是 11-19，而 `cp-01` 是 pending | 证明「未确认不覆盖」（规则 3 / F06） |

---

## 6. 两个状态维度，别混用

```
Field.status : candidate → confirmed
                     ↘ unresolved（相对时间等，需用户补确认）
             missing（原文确实没提，终态）

Note.status  : pending → draft → reviewed
                  ↘ failed（原图仍在，可重试）
```

**相对时间的 UI 要求**：`derived: true` + `status: "unresolved"` 的字段，必须同屏显示「原文『下周三』 · 系统推算 2026-11-25 · 待确认」。只显示推算值等于伪造事实；只显示原文则「今天」页的截止提醒全是空。**可靠参照只有两种**：消息自身明确日期（`reference_source=message_date`，`reference_at` 须等于 `message_date`）或用户指定（`reference_source=user`，请求 `reference_at`）。`captured_at` 是收集时间，**永远不作参照**（当天保存也不行）；无可靠参照时相对节点 `value=null`，展示原文待确认。

**多时间节点（v0.3 V3-2）**：notice 含 `time_nodes` 数组，每节点 `{label, raw, value, precision, tz_known, basis, role, reference_at, reference_source, message_date, derived}`；`basis` ∈ explicit/relative/inferred/superseded，`role` ∈ submission_deadline/event_start/event_end/other/unknown。`deadline` 由后端仅从 submission_deadline 且非 superseded 节点确定性选最早，**前端不要自己选主**；渲染全部节点（superseded 标「已取代」、按 role 标注）。相对时间由模型换算并标 basis，后端不再用关键词解析。**统一参照约束（第四轮）**：basis=relative/inferred 或任何补年（value 年份不在 raw）无可靠参照一律 value=null；schema 对 key=time_nodes 带 if/then 机器关联（value 必须 TimeNode[] 或 null）。

**日期值的格式约定**：date-only 为 `YYYY-MM-DD`；带时刻的统一为 `YYYY-MM-DDTHH:MM:SS±HH:MM`（后端已规范化）。`tz_known=false` 表示**原文未注明时区**：值保留 naive 形状，产品默认按北京时间（UTC+08:00）解释用于比较与逾期判断（非原文事实，见 `timezone_unspecified` warning，需精确时由用户确认）；`precision` 决定显示粒度。前端不要猜字符串形状，按元数据渲染。

---

## 7. `planner()` 的返回契约

架构 canvas 第五节有可交互实现，可直接照它写。关键是返回类型：

```js
plan(tasks, { horizon, budgets, bufferPct }) -> {
  days: [{ date, slots: [{ task_id, minutes, action_text }] }],
  unscheduled: [{ task_id, gap_minutes, reason }],
  gap_total: number,        // 必填，不可省略
  conflicts: [...],
  diff_from_confirmed: [...]
}
```

`reason` 取值：`no_capacity` / `no_due_date` / `not_splittable` / `before_start_date` / `outside_horizon`。

**容量不足时必须显式报出缺口，不得返回看似完整的计划**（PRD F13.3 第 434 行）。`gap_total` 必填就是为了让「假装排完」在结构上写不出来。规则：EDD 贪心（截止近的优先）、允许拆分、每日留 15% 缓冲（可关）、只按天不排时间槽、范围只能 3/7/14 天。

`PlanItem` 只持 `task_id`，**永不回写 Task 的 deadline 或 status**。专注记实际用时，计划条目记计划用时，二者分离。

---

## 8. 需要一起拍板的事（契约虽冻结，这些还没定）

契约当前工作树版本 **0.3.0**（2026-11-18 整改后统一发布；v0.2/v0.2.1 与 V3-1～4 已获产品追认）。升版含义：改语义/删字段必须升版本并同步 schema/typedefs/fixtures/测试/交接包；**前端需对新版本做真实接收确认**，旧本地记录需兼容读取或显式迁移，不清空、不静默当新语义。

架构 canvas 第八节列了 8 条待决策项，其中直接影响你页面结构的：

- **字段确认颗粒度**：建议只有 deadline / materials / submit_to 三类独立确认，其余随便签整体「标记已审阅」一并确认。若改成全字段独立确认，便签详情页要重构成表单。
- **便签唯一主要事项**：建议是（N:1）。若改多对多，要加关联表，搜索与筛选逻辑同步改。
- **删除事项时的任务**：建议保留任务并解除关联，删除前提示。
- **备份导出提级 P0**：建议提级。浏览器会静默驱逐 IndexedDB，比赛现场数据被清就是零分。半天工作量。
- **演示数据隔离**：建议独立 `workspace_id`，退出即清。

另外 PRD 第 9 章还有 13 项待决策，以及 **P0/P1 裁剪**需要三人确认。建议明确推后：F06 变更检测、F05 AI 归组、F09 AI 建议、F13 全部 P1。第 7 天设硬门：黄金路径未走通即冻结所有 AI 增强。

---

## 9. 还没完成的事

| 事项 | 归属 | 状态 |
| --- | --- | --- |
| 3 张通知截图（`fixtures/assets/01~03-*.png`） | PRD 第 568 行属工程辅助/测试；若无第三人需认领 | 待生成，方案见 `fixtures/assets/README.md` |
| FastAPI 契约桩服务 | 后端 | **已交付**，26 条测试通过，真实 uvicorn + HTTP 已验证 |
| 真实视觉模型接入 | 后端 | 待模型服务与密钥确定（任务 #6） |
| 产品前端第一轮闭环（`frontend/`） | 后端代建骨架 + 你接手 | **已实现 + 真浏览器验证**（42 断言、三宽度）；**待你实际签收（不代签）**；剩余 P0（F13/备份恢复/示例隔离/专注）未做 |
| 每日 devlog | 各自 | 规范见 `devlog/README.md`，**比赛硬性要求，含 Qoder 使用记录与截图** |

截图方案有个要点：**不要用图像生成模型直接画通知截图**。中文渲染容易错字，会导致 fixture 里的 `quote.text` 与原图对不上，评委一点开原图就露馅。方案是先写 HTML（正文逐字取自 fixture 的 `raw`）再截图。尤其 fixture 01 的原图必须正确写着「3000字」。

---

## 10. 有问题找谁

契约字段语义、错误码、模型行为 → 后端。
页面结构、交互、本地存储、排程实现 → 你自主决定（PRD 第 8 行明确前端选型与视觉由前端负责人决定）。
契约要改 → 先说，别各自改。改 `models.py` 后必须重跑 `generate.py` 与 `selftest.py`，两份生成物同步更新再发新版。
