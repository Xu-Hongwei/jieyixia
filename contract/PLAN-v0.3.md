# 契约 v0.3 修改计划（产品范围已定 · 实现待验收）

> 日期：2026-11-18｜状态：**本轮产品/范围已定，已实施方向获追认；整改与发布待验收**。
> 执行基线：[产品范围定案与契约变更追认](DECISIONS-2026-11-18.md)。下文历史执行记录保留；“已完成”是当时报告，不自动表示满足本轮新规则。源版本目前仍为 0.2.0，目标统一发布为 0.3.0。
> 中心目标：**消除「prompt / validators / schema 三处规则重复」导致的来回修改**，改为 schema 单一来源 + 提示词自动生成 + 后端同 schema 校验。

---

## 一、当前不足清单（按危害排序）

以下为 v0.3 启动前的问题清单，包含后续已修复或已定案的条目；当前执行状态以第三节及最新决策记录为准。

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
- 后端可执行 validators 继续写在 models.py，schema 从模型生成；散文语义不会自动生成 validator，需显式对齐。
- 目标：统一定义入口并同步生成 prompt/typedefs/schema。语义描述不自动成为可执行 validator；fixtures、解析行为及前端状态机仍需显式对齐和测试，不能把集中描述等同于消除全部语义漂移。
- 性质：内部重构，对外 API 形状不变（additive）。

### V3-2 模型抽取时间节点列表 + 后端确定性选主
- 当前实际形状为 fields 中 key=time_nodes，其 value 为 `[{label, raw, value, precision, tz_known, basis, derived}]`；basis 含 explicit/relative/inferred/superseded。本轮决定后续补 role，且相对时间只在有可靠参照时换算。
- 本轮修订：deadline 仅作提交/完成截止；先按节点 role 筛有效截止，再在可比较候选中选主。活动时间全部保留 time_nodes，不自动充当任务截止；superseded/背景/补班排除，无可靠候选时允许空。
- 追认删除 NL 正则 resolver；模型节点抽取仍存在不确定性，确定性仅指相同结构化输入的选主结果，不能用双跑一致证明所有同图输入稳定。
- 诚实性：basis=relative/inferred ⇒ derived+unresolved；年份/时区不在 raw ⇒ 剥离/标推算（保留为交叉校验）。
- 实际形状：notice 的 Field.key 增加 time_nodes，其 value 为 TimeNode 数组。旧客户端的封闭键/字符串渲染需要升级；不得宣称消费端完全不变。

### V3-3 warning 码枚举
- schema 定义 warning code enum；模型自造码丢弃或归一；后端产生的码不变。
- 消除不足 6。additive（收紧输入侧，输出侧码表固定）。

### V3-4 离线 golden 回归
- 当前已录 13 张真实样本的模型原始输出，实际目录为 `samples/golden/`（私有隔离）；5 份 fixture 为另一套结构/关联校验，不混称为 18 份模型原始输出。后续补可提交的脱敏语义回归。
- 回归 = golden 输出 → parse/validate → 断言字段/元数据/警告，**不打真模型**。
- 消除不足 7；prompt/schema 改动可离线秒级回归。

### V3-5（已定案）裁剪 / PII / 活动时间与相对日期参照
- 应用内裁剪 P1；P0 为预览、正文区域提示和外部裁剪引导。保留原图，未来裁剪另存分析副本；不新增 source_region/OCR 坐标依赖。
- P0 做分析发送告知、真实素材隔离、公开材料检查及日志脱敏；V1 不承诺自动 PII 检测，不引入未经验证的自动 redaction。
- 不新增独立 event_time 顶层键；活动节点在 time_nodes 中按 role 展示。deadline 不自动等于活动开始或任意最早日期。
- captured_at 仅为收集时间；补可选 reference_at 及参照来源，旧截图相对词无可靠参照时保持空值和 unresolved。精度/时区与人工选择规则见最新决策第 4 节。

## 三、实施顺序与验收

> 状态更新（2026-11-18）：**V3-4 已提前完成**（安全网先行）：13 条真实样本模型原始输出录于 `samples/golden/`（gitignore），`backend/regress_golden.py` 离线回归 13/13。检查口径：deadline 键可缺席（契约允许），存在才校验。
> **V3-1 已完成**：语义单一来源进 `contract/models.py`（FIELD_SEMANTICS/STATUS_SEMANTICS/TIME_RULES/CHAT_RULES/EXCLUSION_RULES）；`backend/app/model/render_prompt.py` 从 schema 渲染提示词，core.py 手写散文已删；schema.json 增加 `x-semantics`；新增 4 条渲染一致性测试。验证：126 单测 + 24 负向 + 5 fixture + golden 13/13 + **生成提示词真模型复测 13/13**。
> 顺序调整为 V3-4 → V3-1 → V3-2 → V3-3 → V3-5（先有安全网再重构）。
> 剩余：主节点选择 nondeterminism 仍在（放假 missing vs 9-25；开题 09:00 vs 11:00）→ V3-2 解决。
> **V3-2 已完成**：`TimeNode` + `time_nodes` 键（notice）；模型抽全部节点并自换相对时间（basis=explicit/relative/inferred/superseded）；后端确定性选主（最早非 superseded 节点）；**NL 正则 resolver 已删除**。改期通知旧日期标 superseded 不参与选主（双跑验证 11-15 一致）。108 单测 + golden 13/13 + 真模型 13/13 + 多节点双跑一致。
> 已知语义局限：① 旧截图的相对词以保存时间参照会算错（已标 unresolved 待确认）；② _schedule 类通知（放假）选主=最早节点含补班日，语义锚点待产品定义（已标 unresolved）。
> **V3-3 已完成**：Warning.code 枚举化（8 码）；模型自造码丢弃、同义码归一；**后端权威码（relative_date_derived/date_year_inferred/candidate_without_value/timezone_unspecified）忽略模型自报**，消除跨来源重复；字段按键去重。码表进 schema 并渲染进提示词。111 单测 + golden 13/13 + 真模型验证字段/warning 均唯一。
> 最新状态：V3-5 产品选项已在本轮定案；现行字符串 min 选主、旧截图参照、共享 Field 确认限制、手动截止来源及版本标识需要整改。不得把此前通过数当作本轮新增规则的通过数。

1. 产品范围与 v0.2/v0.2.1、V3-1..4 实施方向已追认；以 DECISIONS-2026-11-18.md 为准，不再等待产品拍板。
2. V3-1：schema 扩语义 + render_prompt + 删散文；跑现有 122 测试 + 24 负向 + 5 fixture 全绿。
3. V3-4：录 golden；建立离线回归。
4. V3-2：time_nodes + 确定性选主 + 删 resolver；golden 回归 + 真模型 13 案例复测 13/13。
5. V3-3：码枚举；回归。
6. 先修本地保存与领域规则，再按最新 V3-5 结论整改；不开展新增 P1。
7. 统一 schema_version 0.3.0、schema/typedefs/fixtures/测试/HANDOFF/交接包；前端实际签收后验收，不代签。

**验收标准**：定义、生成物和版本一致；新增规则有语义测试；旧日期/活动/补班不误选截止；用户可确认推算值并手动设置截止；无可靠参照不硬算旧截图相对词；隐私边界及前端签收成立。保留历史 golden 与真实案例复测作为补充，不能仅凭格式通过或双跑一致代替正确性验收。

## 四、不做（明确排除）

- 不改对外 API 路径/方法；不引入数据库/鉴权（PRD 非目标）。
- 不把 date/datetime 抹成单一字符串形状（语义精度保留，元数据消歧）。
- 不在 v0.3 做产品 UI（队友职责）。
