# RFC / ADR 索引

设计文档分两类：

- **RFC**：提案，描述"要解决什么问题、整体怎么解"，会随实现演进。
- **ADR**：决策记录，一条决定一份，**不可修改**（只能被新 ADR 取代）。

任何架构级改动必须先有 RFC 或 ADR；聊天里达成的共识不算决定。

## 流程：先需求，后设计

新功能按这个顺序走，**不做需求分析不进入设计**：

```
需求说明（docs/briefs/）
  └─ 目的、消费者与决定、需求分级、非目标、成功判据、前置条件
       ↓
RFC（怎么解）
       ↓
ADR（定下来的决定）
       ↓
实现 + 验证
```

模板见 [briefs/TEMPLATE.md](../briefs/TEMPLATE.md)。RFC 必须引用对应的需求说明。

## 路线图对照（必填）

每份 RFC / ADR 必须有一节 **`## 路线图`**，回答：

| 问题 | 不合格的样子 |
|---|---|
| 推进了哪一项？ | 路线图上没有对得上的条目 |
| **挤掉了哪一项？** | 只说自己有价值，不说它推迟了什么 |
| 若不在路线图上，为什么现在做？ | 「顺手」「反正不大」 |

**没有这一节，RFC 不进评审。** 这是 2026-10-29 偏移的直接产物：
RFC 0006 本身合规，却挤掉了 N2/N3 而没人要求它说明。

## 设计交付门槛（四问）

**每份新 RFC / ADR 必须回答这四项**，缺一项不算完成设计（详见 [quality.md §4.1](../quality.md)）：

| # | 问题 |
|---|---|
| 1 | **何时可以实施**：前置条件是什么？什么条件下不做？ |
| 2 | **怎么实施**：改哪些文件、按什么顺序、每步的中间状态是否可用？ |
| 3 | **如何验证**：可执行的验收命令或指标；失败时怎么发现？ |
| 4 | **有没有消费者**：现在谁会用？没有消费者的接口不新增 |

附加规则：字段与接口必须有**当前**消费者；未实现的能力返回 `null`，不返回假值。


## 状态

| 状态 | 含义 |
|---|---|
| Proposed | 待评审 |
| Accepted | 已生效，实现以此为准 |
| Superseded | 被后续 ADR 取代（保留原文，标注取代者） |
| Rejected | 讨论过但未采纳（保留，避免重复讨论） |

## RFC

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-foundations.md) | 基础设计：定位、四个动词、接入阶梯 | Accepted |
| [0002](0002-affect.md) | 输入侧情感层：两套情绪、数据流、已知局限 | Accepted |`n| [0003](0003-self-improvement.md) | 自我改进环路：证据 → 策略 | Proposed |`n| [0004](0004-validity-supersession.md) | 记忆的时效与取代 | Accepted |`n| [0005](0005-dsh-tools.md) | DSH 工具：soul_recall / soul_remember | Accepted |`n| [0006](0006-injection-pre-step.md) | 在 agent/pre-step 注入上下文记忆 | Proposed |

## ADR

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](../adr/0001-positioning.md) | 只做 soul 层，不做 runtime | Accepted |
| [0002](../adr/0002-language.md) | 实现语言选 TypeScript | Accepted |
| [0003](../adr/0003-storage.md) | SQLite 默认，人格自研、内容可外接 | Accepted |
| [0004](../adr/0004-dependencies.md) | core 零运行时依赖 | Accepted |
| [0005](../adr/0005-protocol.md) | 四动词协议 + 语义化版本 | Accepted |
| [0006](../adr/0006-licensing.md) | 许可证选 Apache-2.0 | Accepted |
| [0007](../adr/0007-integration-tiers.md) | 接入分四级，验证宿主是 DSH | Accepted |
| [0008](../adr/0008-transcript-scope.md) | transcript 只读 user turn 与最终回复 | Accepted |
| [0009](../adr/0009-content-memory.md) | v0 不做内容记忆适配器 | Accepted |
| [0010](../adr/0010-evaluation.md) | v0.1 单臂评估，四臂留 P3 | Accepted |
| [0011](../adr/0011-quality-gates.md) | 质量门禁 | Accepted |
| [0012](../adr/0012-affect-scope.md) | affect 只改措辞与采样，不桥接情绪 | Accepted |
| [0013](../adr/0013-affect-lexicon.md) | 只采纳 DUTIR 结构，种子表自写 | Accepted |
| [0014](../adr/0014-affect-injection.md) | 白名单注入 + 置信度门槛 + 反谄媚 | Accepted |
| [0015](../adr/0015-affect-analyzer.md) | 分析器端口化，模型 opt-in | Accepted |
| [0016](../adr/0016-rule-budget.md) | 规则预算 / dev-holdout / 消融 / 停写触发 | Accepted |
| [0017](../adr/0017-emotion-behavior.md) | 情绪→行为：7 变量、三臂、四条判据 | Accepted |
| [0018](../adr/0018-growth.md) | 成长→行为：5 变量、4 周、六条判据 | Accepted |
| [0019](../adr/0019-steering-files.md) | 与 AGENTS.md 的边界与必要性判据 | Accepted |
| [0020](../adr/0020-storage.md) | 存储位置、身份、迁移、并发 | Accepted |
| [0021](../adr/0021-sync.md) | 跨设备同步：分片 JSONL + LWW | Accepted |
| [0022](../adr/0022-steering-import.md) | steering 文件导入的抽取与分类规则 | Accepted |
| [0023](../adr/0023-dsh-adapter.md) | DSH 适配器：T0 skill + 可移植转写 | Accepted |
| [0024](../adr/0024-adapters.md) | 适配层归属：独立包 + core 定契约 | Accepted |
| [0025](../adr/0025-model-capability.md) | 可选模型能力：构造注入 + 适配器义务 | Accepted |

## 相关文档

- [thesis](../thesis.md)：核心命题与可证伪预测（最高判据）
- [architecture](../architecture.md)：分层与依赖规则
- [protocol.v0](../spec/protocol.v0.md)：四个动词的具体契约
- [affect.v0](../spec/affect.v0.md)：情感分析契约、规则与黄金集
- [storage.v0](../spec/storage.v0.md)：路径、身份、迁移
- [sync.v0](../spec/sync.v0.md)：跨设备合并语义
- [transcript.v1](../spec/transcript.v1.md)：可移植会话转写格式
- [quality](../quality.md)：质量模型与评审清单
- [references](../references.md)：外部资料的去留
