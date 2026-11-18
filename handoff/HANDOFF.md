# 前端交接说明 · 契约 v0.1

> 交接日期：2026-11-17｜后端负责人整理｜**先读这一份，再翻其它文件**
> 契约版本 **v0.2**（`schema_version 0.2.0`）：键集合与值类型是机器约束，越界即 422；定案见包内 `contract/REVIEW-v0.2.md`（待追认）。
> 结论：**你现在就可以完全脱离后端开工。** 5 份 fixture 可直接当 mock 响应和演示数据。

---

## 1. 包里有什么

| 路径 | 用途 | 你要不要读 |
| --- | --- | --- |
| `HANDOFF.md` | 本文件 | 必读 |
| `contract/README.md` | 端点表、错误语义、幂等、状态机、相对时间约定 | 必读 |
| `contract/typedefs.d.ts` | 类型声明（生成物） | 直接用，不必读 |
| `contract/schema.json` | 机器可读契约，40 个定义 | 需要时查 |
| `contract/models.py` | **契约的唯一手写来源** | 不必读；有争议时以它为准 |
| `contract/generate.py`、`selftest.py` | 后端的生成与自测工具 | 不必读 |
| `fixtures/*.json`、`index.json` | 5 份共用数据 | 必读 `index.json` |
| `fixtures/assets/README.md` | 3 张演示截图的生成方案与脱敏要求 | 若你认领截图则读 |
| `architecture/*.canvas.tsx` | 架构与领域模型评审基线（Qoder Canvas 打开） | 建议看，尤其第二节实体图与第五节排程 |
| `PRD/*.md` | 需求草案 v0.2，**未冻结** | 必读第 4、6、9 章 |
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
 * @returns {Promise<AnalyzeResponse>}
 */
export async function analyze(sourceId, imageBase64, capturedAt) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, kind: 'image', image_base64: imageBase64, captured_at: capturedAt }),
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

**键集合按类型封闭，v0.2 起是机器约束（schema 校验，越界即 422）**：通用键 `title, deadline`；notice 另加 `requirement, constraints, submit_to, reminder`；tutorial 另加 `summary, steps, cautions`；reference 另加 `summary, keywords`。日期一律走 `deadline` 或 `constraints`，不再有 `presentation_date` 之类的自创键。

**多截止节点**：`deadline` 只放主提交截止（单一日期值）；其余节点以「事项：日期」形式进 `constraints`。

**value 可能是字符串或字符串数组**（`constraints` / `steps` / `cautions` 常见数组），UI 需两种都渲染。

仍建议遍历 `fields` 通用渲染、对未知键降级显示而非崩溃：**prompt 不是机器约束**，模型仍可能越界；键枚举的硬保证在契约 v0.2。

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

**相对时间的 UI 要求**：`derived: true` + `status: "unresolved"` 的字段，必须同屏显示「原文『下周三』 · 系统推算 2026-11-25 · 待确认」。只显示推算值等于伪造事实；只显示原文则「今天」页的截止提醒全是空。参照日期是 `captured_at`。

**日期值的格式约定**：date-only 为 `YYYY-MM-DD`；带时刻的统一为 `YYYY-MM-DDTHH:MM:SS±HH:MM`（后端已规范化，模型产出与推算产出同形状）。前端可直接 `new Date(value)`；不要假设存在不带时区或不带秒的变体。

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

契约 v0.1 的状态是「已冻结，待团队评审确认」。冻结含义是**只增不改**：加字段可以，改语义或删字段必须升版本并同步 fixture。

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
