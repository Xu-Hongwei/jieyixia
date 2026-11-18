# 契约 v0.1

> 状态：**v0.1 已冻结，待团队评审确认**。冻结的含义是「只增不改」——新增字段可以，改语义或删字段必须升版本并同步 fixture。
> 唯一手写来源：[`models.py`](models.py)。`schema.json` 与 `typedefs.d.ts` 是生成物，**不要手改**。

## 生成与校验

```bash
python contract/generate.py          # 导出 schema.json + typedefs.d.ts，并校验 fixtures
python contract/generate.py --check  # 只校验，不写文件
python contract/selftest.py          # 负向自测：证明守卫真的会拒绝违规数据
```

环境：Python 3.12 + pydantic 2.10（本机已具备，无需额外安装）。

`selftest.py` 覆盖 18 条负向用例，全部必须被拒绝。它存在的理由是：一个恒真的校验器等于没有校验器。改动 `models.py` 后必须重跑这两个脚本。

## 端点

| 端点 | 阶段 | 请求 → 响应 | 失败语义 |
| --- | --- | --- | --- |
| `POST /api/analyze` | P0 | `AnalyzeRequest` → `AnalyzeResponse` | 413 图片超限（原图已在本地，提示压缩重试）；422 模型输出不合 schema 或请求非法（前端落 `Note.status=failed`，保留原图，可重试）；503 模型不可用（隐藏 AI 入口，保留「仅保存」） |
| `GET /api/healthz` | P0 | — → `HealthResponse` | 不可达 → 前端进入离线态，本地功能全部照常 |
| `POST /api/match` | P1 | `MatchRequest` → `MatchResponse` | 不确定时返回空 `suggestions`，不强行归组；503 静默跳过 |
| `POST /api/suggest-action` | P1 | `SuggestActionRequest` → `SuggestActionResponse` | `basis=requirement` 必须带 `evidence`，否则 422；503 时手动填写行动仍可开始专注 |
| `POST /api/parse-tasks` | P1 | `ParseTasksRequest` → `ParseTasksResponse` | 不可靠项进 `unresolved`；503 退回结构化批量录入 |

**幂等**：`source_id` 由客户端生成。上传成功但分析超时后重试，只带同一个 `source_id`，不得产生第二份资料。

**后端不留存**：不建库、不建表、不落用户原图、不把图片写进普通运行日志（PRD 第 365 行）。图片只在这一次请求里以 base64 出现。模型密钥只在后端环境变量。

## 写进类型的业务规则

这些不是文档约定，是 `models.py` 里会抛 `ValidationError` 的硬约束：

| 规则 | 实现位置 |
| --- | --- |
| AI 不得返回 `confirmed` 字段，`origin` 必须是 `model`（规则 3） | `AnalyzeResponse._check` |
| `missing` 字段不得带 value（F02 不补造事实） | `Field._check` |
| 有原文的 `candidate`/`unresolved` 必须带 `quote`（规则 4） | `Field._check` |
| `unresolved` 必须给出原文或标明 `derived`（规则 7） | `Field._check` |
| 截止时间必须记录出处便签（决策项 5） | `Deadline._check` |
| `precision=date` 就只能是 `YYYY-MM-DD`，不补 23:59（F07 第 275 行） | `Deadline._check` |
| 只能把已确认字段喂给行动建议（规则 3） | `SuggestActionRequest._check` |
| 声称「原文要求」必须给证据（F09 第 314 行） | `SuggestActionResponse._check` |
| 运行中会话不得有 outcome；卡住必须记卡点（F10） | `FocusSession._check` |
| 关联了专注就必须有实际用时（规则 12） | `PlanItem._check` |
| 计划只按天，不接受时间槽（F13.3） | `PlanItem._check` |
| 无变化不生成候选；候选必须带新旧证据（F06） | `ChangeProposal._check` |
| 规划范围只能 3 / 7 / 14 天（F13.2） | `PlanDraft._check` |

跨 fixture 的不变量由 `generate.py --check` 负责，其中两条最关键：

- **候选未确认时，任务截止时间必须仍等于旧值**（F06 / 规则 3）。
- **全部 fixture 中运行中的专注会话最多 1 个**（规则 8）。

## 两个状态维度，不要混用

```
Field.status : candidate → confirmed
                     ↘ unresolved（相对时间等，需用户补确认）
             missing（原文确实没提，终态）

Note.status  : pending → draft → reviewed
                  ↘ failed（原图仍在，可重试）
```

`note-02` 是刻意构造的反例：便签整体 `reviewed`，但 `deadline` 仍是 `unresolved`。这正是 PRD 第 190 行「字段确认状态与便签整体状态不同，不能互相替代」。

## 相对时间约定

`AnalyzeRequest.captured_at` 是**收集时间**，必填，但**永远不是换算参照**（当天保存也不行）。可靠参照只有两种：消息自身明确绝对日期（节点 `reference_source=message_date`，`reference_at` 须等于 `message_date`），或用户在请求里指定的 `reference_at`（`reference_source=user`）。有可靠参照时模型换算并输出 `value` + `derived: true` + `status: "unresolved"`，保留 `raw` 原文与 `quote`；无可靠参照时 `value=null`，不硬算。前端同屏显示「原文『下周三』 · 系统推算 2026-11-25 · 待确认」。用户确认推算值后 `status=confirmed` 且 `origin=user`、保留 `derived`。

`02-grading-supplement` 就是这个样例：用户在请求里指定 `reference_at=2026-11-17`（周二），「下周三」推算为 11-25，标 derived + unresolved。

## 本地领域模型

`Source / Note / Matter / Task / Action / FocusSession / PlanItem / PlanDraft` 也在这份契约里，虽然它们不走网络。原因：前端 IndexedDB 的存储形状、前端 mock、演示空间初始数据、后端 fixture 必须是同一个形状，否则联调时才发现字段对不上。

所有实体带 `workspace_id`。前端存储 key 一律前缀 `${workspace_id}:`，演示空间用独立 id，退出即清（决策项 8）。

`FocusSession` 用 `started_at + accumulated_ms + running` 表达墙上时钟，**不要用 setInterval 累加**——后台标签页会被节流。

## fixture 的三种用法

| 使用方 | 取哪部分 | 断言什么 |
| --- | --- | --- |
| 后端测试 | `source` + `analyze_request` 作输入 | **不断言精确模型输出**（模型不确定）。断言：响应符合 `AnalyzeResponse`；`content_type` 合理；无 `confirmed` 字段；`unresolved` 项保持未确定；`candidate` 字段带 quote |
| 前端 mock | `expected_analysis` 原样返回 | 作为 canned 响应，确定性可复现 |
| F12 演示空间 | `confirmed_note` / `matter` / `task` / `action` / `focus_session` / `plan_items` / `change_proposal` | 直接灌入 IndexedDB，`is_demo=true`，界面必须标注演示数据 |

`analyze_request.image_base64` 的值是占位符 `__INJECT_IMAGE_BASE64__`，后端测试运行时注入真实图片 base64。前端 mock 忽略该字段。

`expected_analysis.model_name` 一律为 `fixture:<id>`，且带 `demo_data` warning——不得把固定示例结果伪装成真实 AI 实时识别（PRD 第 386 行）。

## 前端接线（Vue 3 + JavaScript）

```jsonc
// jsconfig.json
{
  "compilerOptions": {
    "checkJs": true,
    "strict": true,
    "types": [],
    "paths": { "@contract/*": ["../contract/*"] }
  },
  "include": ["src/**/*.js", "src/**/*.vue", "../contract/typedefs.d.ts"]
}
```

```js
/** @typedef {import('../contract/typedefs.d.ts').AnalyzeResponse} AnalyzeResponse */
```

`typedefs.d.ts` 不参与构建，只供编辑器与 CI 校验。Vite `server.proxy` 把 `/api` 转发到 `127.0.0.1:8000`，注意放开请求体上限（截图 base64 单张可达数 MB，默认值会表现为莫名的 413）。

## 待定项

- 3 张通知截图尚未生成，见 [`../fixtures/assets/README.md`](../fixtures/assets/README.md)。
- F13 批量录入与规划草案的 fixture 留到 v0.2；本轮 5 份对应 PRD F12 第 373-379 行清单。
- `/analyze` 是否需要流式返回：v0.1 定为同步请求 + 客户端可取消。若实测延迟超过 8 秒再议，改流式属破坏性变更，需升 v0.2。
- `Field.key` 目前是自由字符串。等三类内容的字段集稳定后应收敛为枚举，届时升 v0.2。
