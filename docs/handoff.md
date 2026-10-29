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
| 纠正证据 | core + 插件 | 用户纠正时记录两段原文，暂不提炼 |
| 时效 | core | `validUntil` 过期不注入；`supersede` 显式取代 |

## 已知问题（都记在 backlog，观察期内不改）

- **affect 基本失灵**：`同事被裁员，内心空了一块` → `none`；`我不喜欢缩写` → `joy`（B4）
- **不记日常**：只看长期事实/偏好，当前兴趣和近期事件不记（B1）
- 测试句和真实使用不可区分，靠 `测试：` 前缀约定

## 约定（必须遵守）

1. 改动前解释：为什么、怎么做、影响
2. 设计先写需求说明（`docs/briefs/`），再 RFC，再实现
3. 新方向先改阶段文件，调入必须调出
4. 发版前必须看到 `fail 0`
5. 测试消息带 `测试：` 前缀
6. 失败排查先保存原始输出，不猜

## 下一步

1. 观察一周，记录效果判据
2. 到期写 S1 收尾记录（完成/未完成/原因/下一阶段建议）
3. 再决定 backlog 里哪项进入下一阶段

## 从哪看起

- 现在该做什么 → [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)
- 为什么这么做 → `docs/adr/`、`docs/rfcs/`
- 以后做什么 → [roadmap.md](roadmap.md)、[backlog.md](backlog.md)
- 怎么发版 → [runbook.md](runbook.md)
