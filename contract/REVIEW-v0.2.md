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
- [x] 按最新 D3 实现 time_nodes 语义选主，并验证旧日期/活动/补班不误作截止（2026-11-18：role 筛选 + 参照 honesty + 区间置空；真模型 13/13，活动/补班/旧截图相对 deadline 缺席且节点保留）
- [x] 产品/范围悬置项 1–4 已在本轮定案，详见 DECISIONS-2026-11-18.md
- [x] 完成 D4/D6、手动截止来源及统一 0.3.0 的**实现**（119 单测 / 24 负向 / 5 fixture / golden 13/13 / 真模型 13/13）；前端签收与独立测试仍待办

---

## 实现状态同步（2026-11-18，Qoder 整改后）

契约源版本已升 **0.3.0**（API 路径仍 v1）；schema.json / typedefs.d.ts / fixtures / 负向与语义测试 / HANDOFF / 交接包已同步重建。

本轮整改落地（对应 DECISIONS §4/§5）：
- **角色选主**：TimeNode.role 枚举；仅 `submission_deadline` 且非 superseded 参与选主；同精度/同时区知悉状态组内取最早；跨组不可比较 → deadline 缺席 + `deadline_unselectable`。活动开始/补班/背景日期不再误作截止。
- **参照 honesty**：TimeNode.reference_at/reference_source/message_date；relative 仅接受 message_date 自洽、请求级 user 指定、或当日新收集且无冲突消息日期；谎称 user / 旧截图借保存日 → value=null。区间/非法值置空不猜。
- **手动截止**：Deadline.source ∈ note/manual；manual 不要求 from_note_id；两种来源都强制 confirmed_at；AI 不覆盖确认值。
- **确认规则**：Field confirmed 必须有非空值（D5）；用户确认推算值保留 derived+来源（lab 确认不改 origin/derived）。
- **时区**：废止从 captured_at 补偏移；未知时区 naive + 提示；lab 逾期按本地日期（date 型次日起算）。
- **C01 可靠性**：lab 所有写库 try/catch，失败明示不伪成功；删除被引用便签先阻止。
- 模型枚举漂移归一（basis absolute→explicit 等；precision/role/reference_source 非法降级），不再因模型自造枚举整单 422。

验证：119 单测、24 负向、5 fixture、golden 离线 13/13、真模型 13/13（0.3.0）。
仍待办：前端实际签收、独立测试（保存失败/手动截止/旧截图/补班改期/混合时区/重复操作）、产品 P0 闭环、备份恢复/示例隔离前端实现、Qoder Sites 公网验证。

---

## 返工修订（2026-11-18，第二轮：6 项关键问题 + 4 缺口）

上一节整改被退回「暂不通过」，6 项关键问题本轮全部修复并三重验证（单测 / 真 HTTP / 真浏览器）。**本节规则取代上一节中与之冲突的表述**（尤其「当日新收集可借保存日换算」已废止、「lab 确认不改 origin」已改为置 origin=user）。

| # | 退回问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 响应式对象直接写库可复现克隆错误；保存失败后界面已变、编辑框关闭 | lab 写库前 `structuredClone(toRaw(...))`；全部变更改为草稿先行（克隆→改→存→成功才更新 UI），失败界面保持原样且编辑框不关 | 浏览器注入 put 失败：横幅明示、UI/库均未变、编辑框仍开；恢复后成功落库 |
| 2 | `derived=true + confirmed` 被契约拒绝 | 契约允许 derived+confirmed **仅当 origin=user**（保留 derived 与 quote）；lab 确认推算值时置 origin=user | selftest 负向（非 user 仍拒）+ 浏览器确认推算字段落库 {confirmed, origin:user, derived:true} |
| 3 | reference_at 只进后处理，模型看不到 | build_user_text 注入「用户指定参照日期（reference_source=user）」，captured_at 降级为「仅记录，不得作参照」 | 真模型对照：同文本带 reference_at=2026-11-17 → deadline=2026-11-18T17:00 derived/unresolved、节点 reference_source=user |
| 4 | 无消息日期/用户日期时仍能换算「明天」 | captured_at **永远不是可靠参照（当天也不行）**；可靠参照仅 message_date 自洽或请求级 user；否则 relative 节点 value=null | 真模型对照：不带 reference_at → 节点 value=null、deadline 缺席；单测 same-day capture 不换算 |
| 5 | 模型只给 deadline 不给 time_nodes 可绕过新规则 | notice 有 deadline 无节点 → 合成节点走同一管线（纯相对词→relative，无 user 参照置空）；非 notice 纯相对无 user 参照 → deadline 置空 | 4 条新单测 + 真模型「明天下午5点」无参照场景 |
| 6 | 不同 UTC 偏移按字符串比较选错最早截止 | datetime+tz_known 组改用 `datetime.fromisoformat` 按绝对时刻比较 | 单测：14:30+08:00（=06:30Z）胜过 09:00Z |

4 缺口同轮修复：TimeNode 进 ALL_MODELS 导出 typedefs；删除便签解除 task.note_ids 关联（仅 deadline.from_note_id 引用才阻止）；手动日期/节点值做日历合法性校验（2026-02-30 拒绝）；lab 新增逐节点编辑器（role/basis/参照/值，保存重算 precision/tz_known/derived，保留 raw）。

验证汇总：**129 单测、27 负向守卫、5 fixture、golden 离线 13/13、真模型 HTTP 对照、浏览器逐项证据**。schema 41 定义（+TimeNode）。生成物/fixture 02（改用 user 参照）/HANDOFF/交接包已重建同步。
仍待办：前端实际签收（不代签）、独立语义测试、产品 P0 前端闭环、Qoder Sites 公网验证。本轮不提交/不推送/不发布。
