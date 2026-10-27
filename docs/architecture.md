# 架构

> 本文与 [ADR 0001–0011](rfcs/README.md) 同步；两者冲突时**以 ADR 为准**。架构级变更必须先有 RFC 或 ADR。

## 一、唯一的原则

**依赖只能朝内。** `core` 不认识任何宿主、任何数据库、任何模型。

```
宿主 adapter ──▶ core ──▶ ports(接口)
                  ▲            ▲
                  └── 实现 ─────┘  (sqlite / postgres / 外部记忆服务)
```

违反这条原则的 PR 直接拒——不是风格问题，是这个项目能不能跨宿主存在的根本。

## 二、分层

```
packages/
  core/            人格状态、评分、注入、反思。零外部依赖。
    src/types.ts       领域模型（纯类型，无逻辑）
    src/scoring.ts     检索打分（纯函数）
    src/context.ts     注入组装（纯函数 + store）
    src/reflect.ts     会话反思（LLM 由外部注入）
    src/store.ts       SoulStore 接口
    src/sqlite.ts      SQLite 实现（node:sqlite）
  eval/            评估套件（对外的可信度来源，必须公开）
  adapter-*/       每个宿主一个包，只做翻译
  cli/             soul init / remember / context / reflect / stats
```

**边界规则**

| 包 | 允许依赖 | 禁止 |
|---|---|---|
| `core` | node 内置模块 | 任何 npm 包、任何宿主 |
| `adapter-*` | `core`、宿主 SDK | 互相依赖 |
| `cli` | `core` | 直接拼 SQL |

## 三、领域模型（v0）

```ts
Memory {
  id, soulId, userId,
  type: semantic | episodic | strategy | cognition | relationship | trait | fact
  content: string
  importance: 1..10        // 决定"值不值得想起"
  vividness: 0..1          // 随时间衰减
  recallCount: number      // 被想起的次数
  status: active | superseded | archived
  visibility: private | shared
  validFrom?, validUntil?, supersededBy?
  createdAt, lastRecalledAt?
  keywords: string[]
}
```

**为什么没有 embedding 字段**：v0 用关键词打分，够用且零依赖。
向量是 `SoulStore` 的一个可选实现细节，不是领域概念。**领域模型里出现 `vector` 字段那天，就是抽象漏了。**

## 四、端口

只有两个，别加。

```ts
interface SoulStore {
  put(m: Memory): void
  query(spec: QuerySpec): Memory[]
  touch(ids: string[]): void        // recallCount++, lastRecalledAt=now
  // 身份与情绪
  identity(soulId): Identity
  emotion(soulId, userId): Emotion
  saveEmotion(soulId, userId, e): void
}
```

**不做 ORM、不做 repository 泛型、不做 UnitOfWork。** 一个接口 6 个方法，一个实现 300 行。

## 五、存储策略

| 阶段 | 默认 | 可选 |
|---|---|---|
| v0 | SQLite（`node:sqlite`，零配置） | — |
| v1 | SQLite | Postgres（多人/团队） |
| v2 | SQLite | 外部记忆服务（Supermemory / Mem0）作为 `ContentStore` |

**人格状态永远自己存**（结构化、量小、语义精确）。
**内容记忆可以外接**（量大、检索重、已经商品化）。

这条分界就是 [thesis.md](thesis.md) 推论 A 的工程表达。

## 六、接入阶梯（ADR 0007）

不是"接某个宿主"，而是四级阶梯，逐级增加依赖：

| 级别 | 形态 | 依赖宿主 | 目标版本 |
|---|---|---|---|
| T0 | `SKILL.md` + CLI | 能读指令、能跑命令 | v0.1 |
| T1 | transcript 摄取 | 会话文件可读（DSH: `session.v4.jsonl.zstd`） | v0.1 |
| T2 | hooks / 扩展 | 生命周期钩子（Claude Code） | v0.2 |
| T3 | MCP server | 支持 MCP | v0.3 |

**验证宿主 = DSH，发布宿主 = Claude Code。** T0+T1 已足以验证"跨会话连续性"，T2/T3 是体验优化。

**验收标准**：第二个 adapter 接入时，`core` 的改动必须 < 20%。超了说明协议错了，回去改协议而不是打补丁。

## 七、隐私与数据

- 默认落盘 `~/.soulbridge/soul.db`，默认零遥测
- 所有记忆可 `export` / `delete` / 迁移到另一台机器
- 注入文本默认不落日志（debug 模式除外，且需显式开启）
- transcript 只读 `user` 消息与 assistant 最终回复，跳过工具输出与推理段（ADR 0008）

## 八、非目标

见 [ADR 0001](adr/0001-positioning.md) 与 [RFC 0001 §4](rfcs/0001-foundations.md)。此处不再重复，避免两份文档各自漂移。
