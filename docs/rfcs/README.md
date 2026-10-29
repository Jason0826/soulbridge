# RFC / ADR 索引

设计文档分两类：

- **RFC**：提案，描述"要解决什么问题、整体怎么解"，会随实现演进。
- **ADR**：决策记录，一条决定一份，**不可修改**（只能被新 ADR 取代）。

任何架构级改动必须先有 RFC 或 ADR；聊天里达成的共识不算决定。

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
| [0002](0002-affect.md) | 输入侧情感层：两套情绪、数据流、已知局限 | Accepted |

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
