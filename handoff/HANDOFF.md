# 前端交接说明 · 契约 0.3.0

> 交接日期：2026-11-17（2026-11-18 返工修订）｜后端负责人整理｜**先读这一份，再翻其它文件**
> 契约版本 **0.3.0**（`schema_version 0.3.0`，API 路径 v1）：键集合/值类型/节点角色/参照为机器约束，越界即 422。定案与追认见包内 `contract/DECISIONS-2026-11-18.md` 与 `REVIEW-v0.2.md`；**前端实际签收仍待办**。
> **2026-11-18 返工已修（后端 + lab 实证）**：① 写库先脱代理深克隆、保存失败界面不变且编辑框不关；② derived+confirmed 放行（须 origin=user，保留推算来源）；③ 用户参照 reference_at 注入模型提示词；④ 保存日永不作相对时间参照（当天也不行）；⑤ 模型只给 deadline 也合成节点走选主/参照规则；⑥ 带时区截止按绝对时刻比较。另：TimeNode 已导出、删除便签解除任务关联、手动/节点日期日历校验、节点编辑器补齐 role/参照字段。
> 结论：**你现在就可以完全脱离后端开工。** 5 份 fixture 可直接当 mock 响应和演示数据。

---

## 1. 包里有什么

| 路径 | 用途 | 你要不要读 |
| --- | --- | --- |
| `HANDOFF.md` | 本文件 | 必读 |
| `contract/README.md` | 端点表、错误语义、幂等、状态机、相对时间约定 | 必读 |
| `contract/typedefs.d.ts` | 类型声明（生成物） | 直接用，不必读 |
| `contract/schema.json` | 机器可读契约，41 个定义 | 需要时查 |
| `contract/models.py` | **契约的唯一手写来源** | 不必读；有争议时以它为准 |
| `contract/generate.py`、`selftest.py` | 后端的生成与自测工具 | 不必读 |
| `fixtures/*.json`、`index.json` | 5 份共用数据 | 必读 `index.json` |
| `fixtures/assets/README.md` | 3 张演示截图的生成方案与脱敏要求 | 若你认领截图则读 |
| `architecture/*.canvas.tsx` | 架构与领域模型评审基线（Qoder Canvas 打开） | 建议看，尤其第二节实体图与第五节排程 |
| `PRD/*.md` | 需求评审定案版 v0.3 | 必读第 4、6、9 章与定案附录 |
| `devlog/README.md` | 比赛要求的每日记录规范 | 必读，你也要记 |
| `devlog/2026-11-17.md` | 后端第 1 天日志，可当格式范例 | 参考 |

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

**确认与来源（0.3.0）**：实际带入任务的关键事实独立确认，整体「已审阅」不能替代；缺失值（value=null）不能点确认为事实；用户确认推算值时保留 `derived=true` 与原文引用，并把 `origin` 记为 `user`（契约要求 derived+confirmed 必须 origin=user，否则 422）。任务截止可来自便签（`source=note`+`from_note_id`）或用户手动（`source=manual`，不伪造便签），两者都记 `confirmed_at`；手动日期必须日历合法（2月30、25点这类形状合法但日历非法的值要拒绝）；任务可以无截止。行动/计划条目完成不自动完成任务。

**时间比较（0.3.0）**：date 型当天不判逾期，自用户本地次日起算；带时区时刻按时间点比较；未知时区 naive 按用户本地解析，不得仅按字符串排序混合时区。

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

**多时间节点（v0.3 V3-2）**：notice 含 `time_nodes` 数组，每节点 `{label, raw, value, precision, tz_known, basis, role, reference_at, reference_source, message_date, derived}`；`basis` ∈ explicit/relative/inferred/superseded，`role` ∈ submission_deadline/event_start/event_end/other/unknown。`deadline` 由后端仅从 submission_deadline 且非 superseded 节点确定性选最早，**前端不要自己选主**；渲染全部节点（superseded 标「已取代」、按 role 标注）。相对时间由模型换算并标 basis，后端不再用关键词解析。

**日期值的格式约定**：date-only 为 `YYYY-MM-DD`；带时刻的统一为 `YYYY-MM-DDTHH:MM:SS±HH:MM`（后端已规范化）。`tz_known=false` 表示时区未知、按用户本地时区解析；`precision` 决定显示粒度。前端不要猜字符串形状，按元数据渲染。

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
| 前端脚手架 | 你 | 未开始 |
| 每日 devlog | 各自 | 规范见 `devlog/README.md`，**比赛硬性要求，含 Qoder 使用记录与截图** |

截图方案有个要点：**不要用图像生成模型直接画通知截图**。中文渲染容易错字，会导致 fixture 里的 `quote.text` 与原图对不上，评委一点开原图就露馅。方案是先写 HTML（正文逐字取自 fixture 的 `raw`）再截图。尤其 fixture 01 的原图必须正确写着「3000字」。

---

## 10. 有问题找谁

契约字段语义、错误码、模型行为 → 后端。
页面结构、交互、本地存储、排程实现 → 你自主决定（PRD 第 8 行明确前端选型与视觉由前端负责人决定）。
契约要改 → 先说，别各自改。改 `models.py` 后必须重跑 `generate.py` 与 `selftest.py`，两份生成物同步更新再发新版。
