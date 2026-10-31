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
| [protocol.md](protocol.md) | 占位文件，只为不让旧链接 404；协议内容在 [spec/protocol.v0.md](spec/protocol.v0.md) |
| 新会话从哪开始 | [handoff.md](handoff.md) |

## 两个"锚"的分工

| 文件 | 管什么 | 判什么 |
|---|---|---|
| [thesis.md](thesis.md) | **方向**：这件事值不值得做，什么情况放弃 | 项目是否该继续 |
| [stages/](stages/) | **范围**：这个阶段做什么、什么时候算完 | 这次改动是否跑偏 |

两者都可以改，所以判断"有没有偏离"用后者——阶段范围 + 完成定义。

## 与 steering 文件的边界

仓库级 `AGENTS.md` / `CLAUDE.md` 不属于这份地图：仓库约定归仓库，个人经验归 soulbridge（见 [ADR 0019](adr/0019-steering-files.md)）。这里不生成、不接管它们。

## 维护规则

1. 新增文档必须能回答"谁读、什么时候读"。答不上来就不加。
2. 同一事实出现第二份时，删掉弱的那份，只留链接。
3. 改完文档跑一次 `node scripts/health-check.mjs`：它会查编号冲突、版本表一致性、声明了但没有写入的字段。
