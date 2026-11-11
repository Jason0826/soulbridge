# 文档地图

这份文件只回答一件事：**想知道 X，该读哪份**。

它不重复任何内容——同一件事只有一处权威，别处只放链接。

## 按问题找

| 想知道 | 读 |
|---|---|
| 这个项目是什么、凭什么成立 | [thesis.md](thesis.md) |
| 现在在哪个阶段、做到哪一步 | [stages/README.md](stages/README.md) → [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md) |
| 下一步做什么、为什么排这个顺序 | [roadmap.md](roadmap.md) |
| 哪些明确现在不做、什么条件才启动 | [backlog.md](backlog.md) |
| 为什么这么设计 | [adr/](adr/)（一个决定一份）、[rfcs/](rfcs/)（完整方案） |
| 具体公式、字段、阈值 | [spec/](spec/) |
| 某个需求从哪来、消费者是谁 | [briefs/](briefs/) |
| 检索层现在多少分、怎么复现 | [eval-longmemeval-baseline.md](eval-longmemeval-baseline.md) |
| 用户能当场验证的最小能力是什么 | [mvp.md](mvp.md) |
| 怎么发版、出问题怎么处理 | [runbook.md](runbook.md) |
| 质量红线、设计交付四问 | [quality.md](quality.md) |
| 架构总览 | [architecture.md](architecture.md) |
| 外部证据与阅读笔记 | [references.md](references.md) |
| DSH 运行时已验证的事实 | [dsh-runtime.md](dsh-runtime.md) |
| 为什么模型环节要这么验收 | [eval-boundary-0027.md](eval-boundary-0027.md) |
| 未来哪些决策可以考虑本地小模型 | [decision-points.md](decision-points.md)（参考，当前不做） |
| 画图工具与可借鉴的工程做法 | [see-code-lessons.md](see-code-lessons.md)（参考，当前不做） |
| Claude Code 的记忆怎么做的、哪些该抄、我们哪里更好 | [claude-code-memory-lessons.md](claude-code-memory-lessons.md)（参考，当前不改实现） |
| 201 条规则里到底有几条倾向、证据够不够 | [experiments/2026-11-09-rule-compression.md](experiments/2026-11-09-rule-compression.md)（读数已出，准入线待拍板） |
| [protocol.md](protocol.md) | 占位文件，只为不让旧链接 404；协议内容在 [spec/protocol.v0.md](spec/protocol.v0.md) |
| 新会话从哪开始 | [state.md](state.md)（唯一现状态文档） |
| state.md 里超过一周的旧条目去哪了 | [state-archive/](state-archive/)（归档不删除，规则见「维护规则」4） |
| 一个词到底什么意思、它的声明在哪 | [glossary.md](glossary.md)（改 `config/` 值域前必读） |
| 现在欠着什么、下一步该先还哪笔 | [debt.md](debt.md)（做决定前先看） |
| 全系统审计与 review 方法 | [audit/2026-11-02-whole-system.md](audit/2026-11-02-whole-system.md) |
| **一次交付要走哪十步** | [process.md](process.md)（规范；每步都有判定方式） |
| **名词/变量声明在哪** | [declarations.json](declarations.json)（唯一声明登记，`health-check` 第 8 节判定） |
| **旧表示退场到哪一步** | [retirements.json](retirements.json)（`health-check` 第 7 节判定） |
| 代码审查发现与已修项 | [audit/2026-11-02-code-review.md](audit/2026-11-02-code-review.md) |
| **代码规范（可判定）** | [code-quality.md](code-quality.md) |
| **每次改动的清单** | [checklist.md](checklist.md) |
| **我们积累的通用规则（一页索引）** | [rules.md](rules.md) |
| **可放进 steering file 的通用原则（可直接粘贴）** | [steering-project-principles.md](steering-project-principles.md) |
| **词表与字段的差异表（重构第 2 步）** | [spec/vocabulary-map.v1.md](spec/vocabulary-map.v1.md) |
| 整体 review（2026-11-03） | [audit/2026-11-03-review.md](audit/2026-11-03-review.md) |

## 两个"锚"的分工

| 文件 | 管什么 | 判什么 |
|---|---|---|
| [thesis.md](thesis.md) | **方向**：这件事值不值得做，什么情况放弃 | 项目是否该继续 |
| [stages/](stages/) | **范围**：这个阶段做什么、什么时候算完 | 这次改动是否跑偏 |

两者都可以改，所以判断"有没有偏离"用后者——阶段范围 + 完成定义。

## 与 steering 文件的边界

仓库级 `AGENTS.md` / `CLAUDE.md` 不属于这份地图：仓库约定归仓库，个人经验归 soulbridge（见 [ADR 0019](adr/0019-steering-files.md)）。这里不生成、不接管它们。

## 当前权威（2026-11-06）

改动前先读这几份，**它们冲突时以 ADR 为准**：

| 主题 | 权威文档 |
|---|---|
| 现状态、版本、已知的坑 | [state.md](state.md) |
| 代码与模型的边界 | [adr/0027](adr/0027-code-vs-model-boundary.md) · [adr/0029](adr/0029-extraction-is-the-models-job.md) · [adr/0030](adr/0030-core-adapter-boundary.md) |
| 模型环节怎么验收 | [adr/0031](adr/0031-model-dependency-acceptance.md) |
| 线索归属默认策略 | [adr/0034](adr/0034-attribution-defaults-to-continue.md) |
| 各阶段读哪几方原文 | [adr/0035](adr/0035-stage-input-contract.md) |
| **记忆分两层、时间与精度** | [adr/0032](adr/0032-two-layers-of-memory.md) |
| **规则 / 画像 / 记忆三层，锚点退场** | [adr/0033](adr/0033-rules-profile-memory.md) |
| 存什么、怎么衰减 | [briefs/0019](briefs/0019-memory-selection.md) |
| **画像的维度与准入** | [briefs/0021](briefs/0021-profile-dimensions.md) |
| 怎么从有限窗口里取 | [briefs/0020](briefs/0020-retrieval-funnel.md) |
| **抽取单位：一条线索一次，事实自包含** | [briefs/0025](briefs/0025-thread-extraction.md) |
| **写入时机：离开点整段抽，结构是产物（取代 0025 §二/§三）** | [briefs/0028](briefs/0028-departure-flush.md) |
| **行为影响：习惯怎么变成主动动作（触发器 + cost-gate + 遵守率）** | [briefs/0018](briefs/0018-behaviour-influence.md) |
| **事实的时间与有效期（valid_from / valid_to）** | [briefs/0027](briefs/0027-time-axis.md) |
| **按需取数：先理解意图，再决定取什么（目录 + 正文 + 动作）** | [briefs/0029](briefs/0029-retrieval-on-demand.md) |
| **人格层重做：场合 × 倾向（新主干，三条并列验收）** | [briefs/0030](briefs/0030-situated-disposition.md) |
| 归纳（按关闭线索，两阶段） | [briefs/0016](briefs/0016-extraction-consolidation.md) |
| 线索（跨中断的话题） | [briefs/0017](briefs/0017-topic-threads.md) |

## 已废弃（不要照做）

下面这些保留了历史，但**设计已被取代**。每份文件顶部都有横幅，状态行写了接替者。

| 废弃文档 | 被谁取代 |
|---|---|
| [briefs/0010 记忆单元](briefs/0010-memory-unit.md) | 轮与步骤（0014）+ 线索（0017） |
| [rfcs/0007 turn_pair](rfcs/0007-turn-pair.md) | 轮与步骤（0014） |
| [briefs/0011 会话层](briefs/0011-conversation-layer.md) | 线索（0017） |
| [briefs/0012 人物层](briefs/0012-people-layer.md) | ADR 0032 |
| [briefs/0013 事件模型](briefs/0013-event-model.md) | ADR 0032 |
| [spec/model.v0](spec/model.v0.md) | ADR 0032 |
| [briefs/0007 检索排序](briefs/0007-retrieval-scoring.md) | 0019 + 0020 |
| [briefs/0009 schema 重设计](briefs/0009-schema-redesign.md) | ADR 0032 |

**曾经误放、已移出的**（不是设计被推翻，是归属错了）：

| 文件 | 去哪了 | 为什么 |
|---|---|---|
| `briefs/0026 成本可见`（已删） | 插件仓库 `dsh-plugin-soulbridge`：`scripts/billing.mjs` + `docs/cost-visibility.md` | 成本与用量是**宿主的运维数据**，不是记忆层的需求。`packages/core` 里没有一行价格逻辑，这个仓库只留数字、不实现计量。编号 0026 不回收，留给以后真正的产品需求 |

**维护规则**：一个设计被推翻时，不是删掉旧文件，而是①顶部加废弃横幅 ②状态行写接替者 ③在这张表里登记。删掉历史等于丢掉"为什么当初错了"。

## 维护规则

1. 新增文档必须能回答"谁读、什么时候读"。答不上来就不加。
2. 同一事实出现第二份时，删掉弱的那份，只留链接。
3. 改完文档跑一次 `node scripts/health-check.mjs`：它会查编号冲突、版本表一致性、声明了但没有写入的字段。
4. **state.md 只留最近 7 天的日期条目**：它是每次必读的热文档，只追加会无限长（11-11 已 163KB/711 行）。超期条目移进 `state-archive/YYYY-MM.md`——归档不删除（grep 仍能找到），衰减的只是"被想起的概率"；移之前先上浮：仍为真的事实先进接手须知或固定章节。执行 `node scripts/archive-state.mjs`（`--dry-run` 先看），`health-check` 对超期未归档报 WARN。
