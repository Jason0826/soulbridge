# soulbridge

> **给任何 agent 装上一个人格层。**
> A personality layer for any agent — continuity, forgetting, and growth across tools.

**状态：v0.0.1 骨架 · 未发布 · 接口随时会变**

---

## 它解决什么

Claude Code 记得你在 Claude Code 里说过的话，Cursor 不记得，Pi 不记得。
你的偏好、你的判断、你被纠正过的错——换一个工具，全部归零。

soulbridge 是它们之间那层**不属于任何一家**的记忆与人格：

> 一个 soul，多个宿主；一个人格，持续成长。

## 它不做什么

| 不做 | 为什么 |
|---|---|
| agent runtime | 宿主已经免费提供了，再写一遍是重复劳动 |
| 向量数据库 / RAG 引擎 | 内容是商品，检索可以接现成的 |
| 云端服务 | 默认全本地，数据不出机器 |
| “更像人”的叙事营销 | 只承诺可观测的事 |

## 四个动词

宿主只需要在四个时机调用，就完成了接入：

| 动词 | 时机 | 作用 |
|---|---|---|
| `context()` | 会话开始 | 注入：身份 + 画像 + 相关记忆 + 表达风格 |
| `observe(turn)` | 每轮结束 | 观察：写入经历、更新情绪 |
| `recall(q)` | 需要时 | 召回：按相关性/新旧/重要度/唤醒次数排序 |
| `reflect(session)` | 会话结束 | 反思：把经历固化成策略与认知 |

详见 [docs/protocol.md](docs/protocol.md)。

## 30 秒跑起来

需要 Node ≥ 22.18（用到内置 `node:sqlite`）：

```bash
npx soulbridge init
npx soulbridge remember --type strategy "提交前先跑 make check，能省一轮 CI"
npx soulbridge context --query "要不要先跑测试"
npx soulbridge demo          # 起一个 soul，跑完整 context→observe→reflect→context
```

不需要模型、不需要网络、不需要数据库服务。

从源码开发时：

```bash
npm install && npm run build
node packages/cli/src/cli.ts demo   # 直接跑 TypeScript（Node 22.18+ 原生支持）
```

## 架构

```
宿主（Claude Code / Pi / DSH / Cursor / Codex）
        │ hooks + MCP
        ▼
packages/core   人格状态 · 评分 · 注入 · 反思   （约 800 行，零依赖）
        │
        ▼
SQLite（默认） / Postgres（可选）
```

- **人格状态**（身份 / 情绪 / 策略 / 关系 / 特质）：结构化、量小，SQL 就够
- **内容记忆**（对话片段 / 文档）：v0 用关键词检索，之后可换成向量或外部服务

详见 [docs/architecture.md](docs/architecture.md)。

## 设计文档

| 文档 | 内容 |
|---|---|
| [thesis](docs/thesis.md) | 核心命题、三条可证伪预测、四臂实验、放弃条件 |
| [RFC 0001](docs/rfcs/0001-foundations.md) | 定位、用户、非目标、成功指标、四个动词、接入阶梯 |
| [ADR 索引](docs/rfcs/README.md) | 11 条已生效的架构决定（定位/语言/存储/依赖/协议/许可/接入/范围/评估/质量） |
| [protocol.v0](docs/spec/protocol.v0.md) | 四个动词的完整契约：字段、错误码、降级、测试映射 |
| [quality](docs/quality.md) | 质量模型、九条门禁、五条评审清单 |
| [references](docs/references.md) | 外部资料的去留与过期判断 |

**规则**：架构级改动必须先有 RFC 或 ADR；聊天里达成的不算决定。

## 为什么值得做

见 [docs/thesis.md](docs/thesis.md)：核心命题、三条可证伪预测、四臂实验设计。
如果实验否定它，这个项目就该停——**先定好什么情况下放弃，再开始写代码。**

## 隐私

- 默认 SQLite，落在 `~/.soulbridge/soul.db`
- 零遥测、零上报
- 记忆可导出、可删除、可迁移

## License

[Apache-2.0](LICENSE) —— 含明确专利授权，便于企业采用。第三方声明见 [NOTICE](NOTICE)。

本项目不捆绑任何第三方源码。未来若引入词库等外部资产，必须单独核查许可（[ADR 0006](docs/adr/0006-licensing.md)）。
