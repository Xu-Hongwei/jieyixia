# 契约 v0.2 评审记录 · 硬约束定案

> 日期：2026-11-17｜发起：后端负责人｜状态：**已实施于代码与 schema，待团队追认**
> 追认方式：前端与第三人回复确认，或在协作平台 Discussion 留痕。未追认前 v0.2 已在后端生效；前端若已按 v0.1 开发，需重新取 `typedefs.d.ts` 与 fixtures。
> 原则回顾：v0.1 冻结含义是「只增不改」。v0.2 是**首次破坏性升版**，走例外流程：升 `schema_version` + 同步 fixtures / typedefs / selftest / 后端测试 + 重发交接包。本文件记录每条例外决定的理由。

---

## 已定案的硬约束（机器校验，越界即 422 `model_output_invalid` 并触发多厂家降级）

### D1 键集合按 content_type 封闭 ✅ 采纳

- 通用键：`title`, `deadline`
- notice 另加：`requirement`, `constraints`, `submit_to`, `reminder`
- tutorial 另加：`summary`, `steps`, `cautions`
- reference 另加：`summary`, `keywords`
- **理由**：v0.1 键自由导致同一语义键名漂移（展示日期一会儿 `deadline` 一会儿 `presentation_date`），前端无法预测渲染。prompt 封闭只是软约束，模型仍会越界。
- **影响**：fixtures 02 的 `grading→constraints`、`presentation_date→deadline`；03 的 `reason→constraints`。
- **验证**：selftest 负向「自创键」被拒；真模型 5 样本键集合精确合规。

### D2 per-key value 类型 ✅ 采纳

| 键 | 允许类型 |
| --- | --- |
| `steps`, `cautions`, `keywords` | `list[str]` |
| `constraints` | `str` 或 `list[str]` |
| `deadline` | 单一 date / 规范 datetime 字符串（见 D3） |
| 其余 | `str` |
| 任何键 | `null` 仅当 status 为 `unresolved` 或 `missing` |

- **理由**：v0.1 `value: Any` 让「数组还是字符串」靠运气，前端渲染分支无依据。
- **验证**：selftest「steps 非数组」「reminder 给数组」被拒。

### D3 多截止节点：deadline 单值 + 其余带标签进 constraints ✅ 采纳（方案 a）

- `deadline` = 主提交截止（多个节点时取**最早的那个硬性提交/完成截止**），格式 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM:SS±HH:MM`。
- 其余节点以「事项：日期」进 `constraints`（数组）。
- **备选方案 b（结构化 `deadlines: [{label, value, precision}]`）延后到 v0.3**。理由：`Task.deadline` 本就是单值；F06 变更检测按单节点比较；V1 展示带标签列表足够。方案 b 会同时改 Field、Task、前端确认 UI，超出本轮范围。
- **理由**：实验室.jpg 曾把两个截止挤进一个字符串，前端无法解析。
- **验证**：selftest「deadline 拼接多节点」被拒；真实验室样本输出单一 deadline + 带标签 constraints。

### D4 `derived=true` ⇒ `status=unresolved` ✅ 采纳（契约级）

- 推算值永远待用户确认，不得被模型或后端标成 candidate/confirmed。原先只在测试里断言，现在进 `Field` validator。

### D5 `candidate` 不得为 null ✅ 采纳（契约级）

- 原先仅解析层降级守卫；现在 `AnalyzeResponse` 直接拒绝，双保险。解析层仍保留降级 + `candidate_without_value` warning 以尽量挽救输出。

### D6 datetime 序列化规范 ✅ 固化

- `YYYY-MM-DDTHH:MM:SS±HH:MM`；缺秒补 :00；缺时区用 `captured_at` 偏移；参照无时区不补、绝不默认 UTC；`Z`→`+00:00`；date-only 原样。
- v0.1 后期已实施 `canonical_datetime()`，v0.2 将其固化为 `deadline` 的格式约束（D3 的正则）。

### D7 破坏性升版流程 ✅ 采纳

- 升 `schema_version`（0.1.0 → 0.2.0）；同步重新生成 `schema.json` / `typedefs.d.ts`；同步 fixtures、selftest、后端测试；重发交接包并在 HANDOFF 注明版本。
- 今后任何破坏性变更重复此流程，不允许静默改语义。

---

## 明确延后 / 拒绝的提案

| 提案 | 决定 | 理由 |
| --- | --- | --- |
| 结构化多 deadline（方案 b） | 延后 v0.3 | 见 D3；需同时改 Task 与确认 UI |
| notice 增加独立 `location` / `time_window` 键 | 拒绝 | constraints 带标签已覆盖；键越多漂移面越大 |
| `warnings.code` 枚举 | 拒绝 | 模型自产 warning 码不可穷举；枚举会误拒合法输出 |
| per-key 必填性（如 notice 必须有 deadline） | 拒绝 | 放假安排类通知本就没有单一截止；强制必填会诱发编造 |

---

## 不属于 v0.2、仍待团队拍板的悬置项

1. P0/P1 裁剪（F06 / F05 AI / F09 AI / F13 P1 是否本轮做）
2. PRD 第 9 章 8 条决策项（字段确认颗粒度、便签唯一事项、删除事项时任务归属、备份提级、演示隔离等）
3. 演示是否需要公网地址
4. git 远端平台

这些是产品/工程范围决策，不是契约硬约束，**不在本次实施**。建议一次 30 分钟会议拍板。

---

## 验证汇总（实际执行）

| 项 | 结果 |
| --- | --- |
| `contract/selftest.py` 负向用例 | 24/24 被拒绝（含 6 条 v0.2 新增） |
| `contract/generate.py --check` fixtures | 5/5 通过结构与跨文件不变量 |
| `backend` pytest | 114/114 |
| 真模型（DashScope qwen3.8-flash）5 样本 | 5/5 HTTP 200 且键集合精确合规 |

## 追认 checklist

- [ ] 前端确认已取 v0.2 `typedefs.d.ts` 与 fixtures，渲染支持 `constraints` 数组
- [ ] 第三人确认 selftest 24 条负向覆盖其关心的违规形态
- [ ] 团队确认 D3 方案 a（多截止进 constraints）满足 F06 演示需求
- [ ] 悬置项 1–4 另行会议拍板
