# 契约 v0.2 评审记录 · 硬约束定案

> 初始日期：2026-11-17｜发起：后端负责人｜状态：**2026-11-18 已完成本轮产品追认，按最新决定修订；实现与前端签收仍待验收**。
> 最新执行基线：[产品范围定案与契约变更追认](DECISIONS-2026-11-18.md)。原始测试记录保留历史含义，不代表新增规则已经实现。前端与第三人的实际签收不得代签。
> 原则回顾：v0.1 冻结含义是「只增不改」。v0.2 是**首次破坏性升版**，走例外流程：升 `schema_version` + 同步 fixtures / typedefs / selftest / 后端测试 + 重发交接包。本文件记录每条例外决定的理由。

---

## 已定案的硬约束（机器校验，越界即 422 `model_output_invalid` 并触发多厂家降级）

### D1 键集合按 content_type 封闭 ✅ 采纳

- 通用键：`title`, `deadline`
- notice 另加：`requirement`, `constraints`, `submit_to`, `reminder`；本轮追认后续 v0.3 的 `time_nodes` 扩展。
- tutorial 另加：`summary`, `steps`, `cautions`
- reference 另加：`summary`, `keywords`
- **理由**：v0.1 键自由导致同一语义键名漂移（展示日期一会儿 `deadline` 一会儿 `presentation_date`），前端无法预测渲染。prompt 封闭只是软约束，模型仍会越界。
- **影响**：fixtures 02 的 `grading→constraints`、`presentation_date→deadline`；03 的 `reason→constraints`。
- **验证**：selftest 负向「自创键」被拒；真模型 5 样本键集合精确合规。

### D2 per-key value 类型 ✅ 采纳

| 键 | 允许类型 |
| --- | --- |
| `requirement`, `constraints`, `reminder`, `steps`, `cautions`, `keywords` | `str` 或 `list[str]`（追认已实施的放宽） |
| `time_nodes` | `list[TimeNode]`（v0.3；不得按字符串数组编辑） |
| `deadline` | 单一 date / 规范 datetime 字符串（见 D3） |
| 其余 | `str` |
| 任何键 | `null` 仅当 status 为 `unresolved` 或 `missing` |

- **理由**：v0.1 `value: Any` 让「数组还是字符串」靠运气，前端渲染分支无依据。
- **历史验证口径已变更**：数组允许范围以本表为准；当前 selftest 使用 title/submit_to 等单值键给数组验证拒绝，不再拒绝 reminder 数组。

### D3 deadline 单值 + time_nodes 保留多节点 ✅ 追认结构，修订选主语义

- `deadline` = 提交/完成截止候选，可无值；先按语义筛选有效截止，再在可比较的候选中取最早。不得把活动开始、补班日或任意最早日期当作截止。
- 日期形状保留 date / 带时区 datetime / 未知时区 naive datetime，元数据明确精度与时区是否已知；缺时区不编造。
- **追认已实施的 v0.3 time_nodes**：全部节点结构化保留，superseded 不参与选主；Task.deadline 仍单值。constraints 可保留带标签说明，但不能替代节点列表。活动时间与旧截图参照按最新决策第 4 节整改。
- **理由**：实验室.jpg 曾把两个截止挤进一个字符串，前端无法解析。
- **验证**：selftest「deadline 拼接多节点」被拒；真实验室样本输出单一 deadline + 带标签 constraints。

### D4 AI 推算值待确认；人工确认保留来源 ✅ 修订作用边界

- AI 输出 derived=true 时必须 unresolved，且 AI 不得输出任何 confirmed 字段。用户明确确认具体非空值后，本地 Field 允许 derived=true + confirmed，保留推算来源；便签整体 reviewed 不能替代该操作。
- 当前共享 Field validator 的绝对限制仍需 Qoder 调整；本次追认规则，不把当前实现标为验收通过。

### D5 `candidate` 不得为 null ✅ 采纳（契约级）

- 原先仅解析层降级守卫；现在 `AnalyzeResponse` 直接拒绝，双保险。解析层仍保留降级 + `candidate_without_value` warning 以尽量挽救输出。

### D6 datetime 序列化规范 ✅ 固化

- 带时区 datetime 为 `YYYY-MM-DDTHH:MM:SS±HH:MM`；未知时区保留 naive datetime 并明确标识。缺秒补 :00，`Z`→`+00:00`，date-only 原样。
- **废止旧规则“缺时区用 captured_at 偏移”**：保存时间不证明正文时区；不得补造。相对日期缺少可靠消息参照时保留原文和 unresolved，不静默使用旧截图的保存日。
- v0.1 后期已实施 `canonical_datetime()`，v0.2 将其固化为 `deadline` 的格式约束（D3 的正则）。

### D7 破坏性升版流程 ✅ 采纳

- 升 `schema_version`（0.1.0 → 0.2.0）；同步重新生成 `schema.json` / `typedefs.d.ts`；同步 fixtures、selftest、后端测试；重发交接包并在 HANDOFF 注明版本。
- 今后任何破坏性变更重复此流程，不允许静默改语义。

---

## 明确延后 / 拒绝的提案

| 提案 | 决定 | 理由 |
| --- | --- | --- |
| 结构化多时间节点 | 已追认 v0.3 time_nodes | 保留全部节点，Task 截止仍单值；选主需整改 |
| notice 增加独立 `location` / `time_window` 键 | 拒绝 | constraints 带标签已覆盖；键越多漂移面越大 |
| `warnings.code` 枚举 | 改为追认已实施 V3-3 | 后端统一输出固定码，模型未知码归一或忽略，不改变未确定字段的状态 |
| per-key 必填性（如 notice 必须有 deadline） | 拒绝 | 放假安排类通知本就没有单一截止；强制必填会诱发编造 |

---

## 产品/范围悬置项：2026-11-18 已全部定案

1. P1 暂停新增；P0 验收后才择一开展。F13 规则规划保留 P0，基础备份导出和新空间恢复升级 P0。
2. PRD 第 9 章实际 **13 条**已逐项定案，见最新决策第 2 节。
3. 必须有 Qoder Sites 公开作品入口与无需登录示例；后端托管兼容性另做实际验证。
4. GitHub 已定，origin 已配置；不得由此推断未提交改动已推送。

以上是已定产品选择；代码整改、前端签收、公开发布仍按各自验收门槛执行。

---

## 验证汇总（实际执行）

| 项 | 结果 |
| --- | --- |
| `contract/selftest.py` 负向用例 | 24/24 被拒绝（含 6 条 v0.2 新增） |
| `contract/generate.py --check` fixtures | 5/5 通过结构与跨文件不变量 |
| `backend` pytest | 114/114 |
| 真模型（DashScope qwen3.8-flash）5 样本 | 5/5 HTTP 200 且键集合精确合规 |

## 实施与签收 checklist（产品选择已定，不代签成员）

- [ ] 前端确认已取 v0.2 `typedefs.d.ts` 与 fixtures，渲染支持 `constraints` 数组
- [ ] 第三人确认 selftest 24 条负向覆盖其关心的违规形态
- [ ] 按最新 D3 实现 time_nodes 语义选主，并验证旧日期/活动/补班不误作截止
- [x] 产品/范围悬置项 1–4 已在本轮定案，详见 DECISIONS-2026-11-18.md
- [ ] 完成 D4/D6、手动截止来源及统一 0.3.0 的实现与验收
