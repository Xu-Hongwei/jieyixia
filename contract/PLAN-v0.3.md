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

---

## 五、实现状态同步（2026-11-18，Qoder 整改后）

V3-1～V3-4 已完成并追认；V3-5 的产品决定（DECISIONS §4）已在后端/lab 落地可实现部分：
- 节点 role 枚举 + 语义选主（不靠 label 关键词/任意最小值）；superseded/活动/补班不参与截止。
- reference_at/reference_source/message_date 参照 honesty；旧截图不借保存日换算；无可靠参照 value=null。
- 不新增 event_time 顶层键（活动节点留在 time_nodes 按角色展示）；不新增 source_region/OCR 依赖；不做未经验证的自动 redaction。
- 手动截止 source=manual 合法；confirmed 非空；未知时区不补造；lab 本地日期逾期比较。
- C01：lab 写库失败明示不伪成功；删除被引用便签先阻止。
- 契约统一 **0.3.0**，生成物/样例/测试/交接包同步；119 单测 / 24 负向 / 5 fixture / golden 13/13 / 真模型 13/13。

仍待办（非后端单方可完成）：前端 P0 闭环（备份导出/新空间恢复、示例隔离、规划、专注）、应用内裁剪（P1）、前端实际签收、独立语义测试、Qoder Sites 公网托管验证与发布。本轮不提交/不推送/不发布。

---

## 六、返工修订（2026-11-18，第二轮）

第五节整改被退回「暂不通过」，6 项关键问题 + 4 缺口本轮全部修复，三重验证（单测 / 真 HTTP / 真浏览器）。**本节取代第五节中与之冲突的口径**：参照 honesty 收紧为「captured_at 永远不是可靠参照（当天也不行）」，可靠参照仅 message_date 自洽或请求级 user；用户确认推算值置 origin=user（不再「不改 origin」）。

修复对照（详见 REVIEW-v0.2.md 返工节）：
1. 本地保存：写库前 `structuredClone(toRaw)`；草稿先行，失败 UI 不变、编辑框不关。
2. derived+confirmed 合法化：仅 origin=user，保留 derived/quote。
3. reference_at 注入模型 user_text；captured_at 降级为仅记录。
4. 无可靠参照不换算「明天」，relative 节点 value=null。
5. notice 只给 deadline 无节点 → 合成节点走同一管线，规则不可绕过。
6. 混合时区按绝对时刻（datetime.fromisoformat）选最早，不再字符串比较。
缺口：TimeNode 导出 typedefs；删除解除 task.note_ids；手动/节点日期日历校验；lab 逐节点编辑器。

验证：**129 单测 / 27 负向 / 5 fixture / golden 13/13 / 真模型 HTTP 对照 / 浏览器逐项证据**；schema 41 定义。生成物、fixture 02（user 参照）、HANDOFF、交接包已重建。
仍待办：前端实际签收（不代签）、独立语义测试、产品 P0 前端闭环、Qoder Sites 公网验证与发布。本轮不提交/不推送/不发布。

## 七、返工修订（2026-11-18，第三轮）

第六节复测「仍不通过，但部分修复已生效」，剩 5 项本轮全部修复，三重验证。**本节取代第六节冲突口径**：确认推算值**不再置 origin=user**（回归 D4：确认不改值来源，实际改值才 origin=user）。

1. 截止绕过：相对词检测（含数字的「明天下午5点」也识别）强制 relative，无可靠参照置空；合成节点 role=unknown 不伪造提交角色；提示词补 time_nodes 具体示例，真模型输出带角色节点（活动=event_start 不参与选主）。
2. 原子删除：deleteNoteAtomic 单 IDB 事务「写解关联任务 + 删便签」，失败整体回滚、UI 不动。
3. 并发确认：mutateNote 按 id 串行化 + 每次克隆最新已提交状态，双确认竞态不丢修改。
4. 确认保留来源：契约 derived+confirmed 任意 origin（仍须非空值）；lab 确认只改 status。
5. 跨年：删除年份相等才保留的旧分支，12-31「明天」→ 次年 01-01 合法保留。

验证：**133 单测 / 27 负向 / 5 fixture / golden 用新提示词对真模型重录 13/13 / 真模型 HTTP 5 例 / 浏览器竞态与注入故障证据**。schema 41 定义，生成物重建。
仍待办：前端实际签收（不代签）、独立语义测试、产品 P0 前端闭环、Qoder Sites 公网验证与发布。本轮不提交/不推送/不发布。

## 八、返工修订（2026-11-18，第四轮）

第三轮五项反例通过定向复核，剩一个关键漏洞 + 四项原有待办，本轮全部关闭。

1. **统一参照约束（关键）**：relative/inferred/任何 basis 的补年份，统一要求可靠参照（message_date 自洽 / 请求级 user），缺失值置空保留原文。结构化检查（value 年份是否在原文），不靠扩相对词表；误标 explicit 的「三天后/48小时」同样拦下。跨年、活动 role、superseded、带偏移比较不回归。真模型 6 例配对验证。
2. **仅重试保存**：runAI 保存失败暂存分析结果，重试只落库不重调模型（浏览器 fetch 计数=1 实证）。
3. **嵌套 Proxy**：deepRaw 逐层脱代理，嵌套显式 reactive 写库不再 DataCloneError（真实 putDoc 实证）。
4. **机器契约关联**：Field 运行时 + 生成 schema if/then 双重约束 key=time_nodes → TimeNode[]|null；jsonschema 机器验证 + selftest 双重守卫；TimeNode 补日历探针。
5. **偏移校验**：isValidTimeValue 拒绝 +99:99/+08:75，与后端一致。

验证：**148 单测 / 34 负向 / 5 fixture / golden 13/13 / 真模型 6 例配对 / 浏览器逐项证据**。schema 41 定义（Field 增 if/then）。
仍待办：前端实际签收（不代签）、独立语义测试、产品 P0 前端闭环、Qoder Sites 公网验证与发布。本轮不提交/不推送/不发布。
