# 契约 v0.3 修改计划（草案 · 待评审）

> 日期：2026-11-18｜状态：草案，待团队拍板后实施
> 中心目标：**消除「prompt / validators / schema 三处规则重复」导致的来回修改**，改为 schema 单一来源 + 提示词自动生成 + 后端同 schema 校验。

---

## 一、当前不足清单（按危害排序）

| # | 不足 | 证据 | 危害 |
| --- | --- | --- | --- |
| 1 | **规则三处重复、手工同步** | prompt 散文复述契约规则；改 widening 时 prompt+validator+fixtures 都要动 | 来回修改、漂移、静默不一致 |
| 2 | **部分规则只在 prompt，后端不强制** | 活动类 deadline 语义、聊天窗忽略侧栏、unresolved 语义 | 模型违反也静默通过 |
| 3 | **部分规则只在后端，没告诉模型** | 年份/时区诚实性剥离 | 模型白做、输出被剥、浪费 token |
| 4 | **NL→时间仍正则 resolver** | `resolve_relative_date`/`extract_explicit_date` | 脆：月底/三天后/国庆前/第X周失效 |
| 5 | **多节点主 deadline 选择 nondeterminism** | 奖学金 9-16 24:00 vs 9-17 12:00；放假 missing vs 9-25 | 同图不同结果，交接不可复现 |
| 6 | **warning 码自由** | 模型自造 `relative_date_unresolved` | 码表不统一，前端难消费 |
| 7 | **无离线回归基线** | 每次验证都打真模型 | prompt/schema 改动无法离线回归，慢且贵且 nondeterministic |
| 8 | **整窗截图目标气泡歧义** | QQ 整窗含侧栏/成员/群公告 | 可能混入无关通知；靠 prompt 软约束 |
| 9 | **PII 无自动检测** | 样本隔离靠人工 | 真实人名/校名可能进字段 |
| 10 | **v0.2/v0.2.1 待追认** | 评审 checklist 未回 | 契约基线未正式锁定 |

## 二、v0.3 修改项

### V3-1（中心）schema 单一来源 + 提示词自动生成
- 把**字段语义、类型、枚举、status 语义、时间规则、聊天窗规则**全部进 schema（machine-readable：per-key `description`/`x-semantics`/enum）。
- 新增 `contract/render_prompt.py`：从 schema 渲染 SYSTEM_PROMPT（字段表+类型+规则），**删除手写散文**。
- 后端 validators 继续从同一 models.py 生成（现状保留）。
- 效果：改规则只改 schema 一次；prompt/typedefs/fixtures/校验同步再生成。**消除不足 1/2/3。**
- 性质：内部重构，对外 API 形状不变（additive）。

### V3-2 模型抽取时间节点列表 + 后端确定性选主
- 模型输出 `time_nodes: [{raw, iso, precision, tz, basis}]`（**所有**节点，含相对词换算由模型做，basis 标记 explicit/relative/inferred）。
- 后端**确定性**选主：提交类=最早硬性提交/完成节点；活动类=最早开始节点；其余进 constraints。
- **删除 NL 正则 resolver**（不足 4）；**消除选主 nondeterminism**（不足 5，选择变成确定性代码）。
- 诚实性：basis=relative/inferred ⇒ derived+unresolved；年份/时区不在 raw ⇒ 剥离/标推算（保留为交叉校验）。
- 性质：Field 加 `time_nodes`（additive）；deadline 仍单值输出，消费端不变。

### V3-3 warning 码枚举
- schema 定义 warning code enum；模型自造码丢弃或归一；后端产生的码不变。
- 消除不足 6。additive（收紧输入侧，输出侧码表固定）。

### V3-4 离线 golden 回归
- 录制 13 张真实样本 + 5 fixture 的**模型原始输出**存 `tests/golden/`（含 PII 的样本 golden 需脱敏或仅存结构）。
- 回归 = golden 输出 → parse/validate → 断言字段/元数据/警告，**不打真模型**。
- 消除不足 7；prompt/schema 改动可离线秒级回归。

### V3-5（评审决定）裁剪 UI / PII / event_time
- 整窗歧义：产品 F01 加裁剪 UI；schema 可选 `source_region`。
- PII：后端可选 redaction pass（人名/校名/链接模式）或仅前端提示；需产品拍板。
- 活动类是否独立 `event_time` 键 vs 复用 deadline：评审定。
- 消除不足 8/9（部分）。

## 三、实施顺序与验收

> 状态更新（2026-11-18）：**V3-4 已提前完成**（安全网先行）：13 条真实样本模型原始输出录于 `samples/golden/`（gitignore），`backend/regress_golden.py` 离线回归 13/13。检查口径：deadline 键可缺席（契约允许），存在才校验。
> 顺序调整为 V3-4 → V3-1 → V3-2 → V3-3 → V3-5（先有安全网再重构）。

1. 评审拍板 V3-1..V3-5 范围 + 追认 v0.2/v0.2.1（不足 10）。
2. V3-1：schema 扩语义 + render_prompt + 删散文；跑现有 122 测试 + 24 负向 + 5 fixture 全绿。
3. V3-4：录 golden；建立离线回归。
4. V3-2：time_nodes + 确定性选主 + 删 resolver；golden 回归 + 真模型 13 案例复测 13/13。
5. V3-3：码枚举；回归。
6. V3-5：按评审结论实施。
7. 升 schema_version 0.3.0；重发交接包；追认。

**验收标准**：改一条规则只改 schema 一处；prompt 与 validators 无手工重复；13 真实案例离线 golden 回归 + 真模型复测均 13/13；多节点同图重复跑主 deadline 一致。

## 四、不做（明确排除）

- 不改对外 API 路径/方法；不引入数据库/鉴权（PRD 非目标）。
- 不把 date/datetime 抹成单一字符串形状（语义精度保留，元数据消歧）。
- 不在 v0.3 做产品 UI（队友职责）。
