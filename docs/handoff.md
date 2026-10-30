# 交接（Handoff）

> 新会话从这里开始读。读完这份 + 注入的记忆，再决定要不要动代码。

## 一句话

`soulbridge` 是给 agent 装的人格层（四个动词：context / observe / recall / reflect），
零运行时依赖，DSH 是第一个宿主。

## 现在在做什么

**S1 阶段：DSH 记忆闭环**，从 2026-10-29 开始计时，7 天，到 11-05。

- 入门条件已全绿（插件加载、注入每轮 ≤1、蒸馏无 failed、真实库、WAL 备份已修）
- **观察期内只修 bug，不加功能**
- 看 [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)：四条效果判据 + 观察记录

## 版本

| 组件 | 版本 | 状态 |
|---|---|---|
| core | 0.0.22 | 已发布 npm |
| dsh-plugin | 0.0.31 | 已装进 profile |

## 机制速览（都在跑）

| 机制 | 位置 | 说明 |
|---|---|---|
| 自动观察 | 插件 `session/event` | 每条用户消息 → `observe`：规则优先，漏了才问模型 |
| 注入 | 两层 | `systemPrompt.section` 放锚点（importance ≥8）；`agent/pre-step` 按当前消息检索相关记忆，每轮一次 |
| 工具 | `soul_recall` / `soul_remember` | **只有新建会话才看得到**（工具集在会话创建时固定） |
| 写入闸门 | core | shape → semantic → budget，`committed` 表示真的落库 |
| 纠正证据 | core + 插件 | core 已有 `detectCorrection`（L1 规则 + L2 结构，黄金集 3/6、精度 100%）；**插件尚未更新，真机 `corrections` 仍为 0 行** |
| 时效 | core | `validUntil` 过期不注入；`supersede` 是**手动 API**，没有业务调用者 |

## 已知问题（都记在 backlog，观察期内不改）

- **affect 基本失灵**：`同事被裁员，内心空了一块` → `none`；`我不喜欢缩写` → `joy`（B4）。词表 75 词，真实句 7 个里 6 个零命中
- **不记日常**：只看长期事实/偏好，当前兴趣和近期事件不记（B1）
- 测试句和真实使用不可区分，靠 `测试：` 前缀约定
- **情绪状态已饱和**：`bond=2.0`（上限）、`tension=0.03`、其余四维从未变化 → "像朋友聊天"成了常量。设计见 [briefs/0006](briefs/0006-emotion-dynamics.md)
- **没有"证据等级"**：不知道一条记忆是用户原话、规则抽的，还是模型归纳的（[briefs/0007](briefs/0007-retrieval-scoring.md)）
- **schema 有死字段**：`visibility` 恒为 private、`vividness` 永不变化、`valid_until`/`superseded_by` 全 NULL。重设计见 [briefs/0009](briefs/0009-schema-redesign.md)

## 约定（必须遵守）

1. 改动前解释：为什么、怎么做、影响
2. 设计先写需求说明（`docs/briefs/`），再 RFC，再实现
3. 新方向先改阶段文件，调入必须调出
4. 发版前必须看到 `fail 0`
5. 测试消息带 `测试：` 前缀
6. 失败排查先保存原始输出，不猜

## 下一步

1. 观察一周，记录效果判据（判据 1 和 3 只有用户能判）
2. **提前收口触发条件**：若到 2026-11-02 判据 2 的抽查样本仍 < 5 次，说明观察设计没产生可用数据 → 提前收口，把"观察设计失败"写进收尾记录
3. 到期写 S1 收尾记录（完成/未完成/原因/下一阶段建议）
4. 再决定 backlog 里哪项进入下一阶段

## 最近变化（2026-10-30）

- 纠正检测：core 加了 `detectCorrection`（规则 + 结构两层），黄金集 `test/fixtures/correction-golden.ts`；**插件未更新，尚未在真机生效**
- 文档：新增 [briefs/0005](briefs/0005-eval-harness.md)（评估 harness）、[0006](briefs/0006-emotion-dynamics.md)（情绪动力学）、[0007](briefs/0007-retrieval-scoring.md)（检索骨架）、[0008](briefs/0008-correction-detection.md)（纠正检测）、[0009](briefs/0009-schema-redesign.md)（schema 重设计）
- 工具：`scripts/health-check.mjs`（结构体检）、`scripts/field-audit.mjs`（字段审计）
- 索引：[docs/README.md](README.md) 是文档地图，先看它再决定读哪份
- 调研：Harness²（Google 递归 harness）的读数写在 [references.md](references.md)

## 从哪看起

- 现在该做什么 → [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)
- 为什么这么做 → `docs/adr/`、`docs/rfcs/`
- 以后做什么 → [roadmap.md](roadmap.md)、[backlog.md](backlog.md)
- 怎么发版 → [runbook.md](runbook.md)
