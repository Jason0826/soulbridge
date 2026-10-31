# 交接（Handoff）

> 新会话从这里开始读。读完这份 + 注入的记忆，再决定要不要动代码。

## 一句话

`soulbridge` 是给 agent 装的人格层（四个动词：context / observe / recall / reflect），
零运行时依赖，DSH 是第一个宿主。

## 现在在做什么

**S1 已提前收口（2026-10-31）** —— 触发「观察设计未产生可用数据」。

- 四条判据里两条**无法判定**：判据 2 抽不了（日志不记注入内容）、判据 1 的时间尺度与实际使用模式不匹配
- 判据 3 的数据源精度 **11%**（28 条"纠正"里 25 条是否定词误判）
- 工程底线（注入不回写 / 蒸馏失败 4.0% / 无重复注入）**全绿**
- 结论：S1 没证明记忆有用，也没证明没用——**它证明了现在的观察方法测不出来**
- 完整收尾记录：[stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)

**下一步（按优先级）：先修观察手段 → 再定「一条记忆是什么」（[briefs/0010](briefs/0010-memory-unit.md)）→ 最后谈功能。**

## 版本

| 组件 | 版本 | 状态 |
|---|---|---|
| core | 0.0.24 | BM25 检索（IDF + 长度归一化）；已 overlay 进 profile，**待重启生效** |
| dsh-plugin | 0.0.33 | 注入日志记 `ids`；已 overlay 进 profile，**待重启生效** |

> 2026-10-31 overlay 前的旧版本备份在 `profiles/desktop/soulbridge-overlay-bak-20261031-150143`。

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

## 设计债（2026-10-30 盘点）

**设计已经跑在实现前面**：`briefs/0005`–`0009` 共 **607 行设计**，对应落地约 **80 行**（`detectCorrection`）。
其余全部是 Draft，没有一行实现。这不是问题，但要记着——**声明多于能力时，最容易高估自己**。

| 设计 | 状态 | 前置条件 |
|---|---|---|
| 0005 评估 harness | Draft | 需要消费者；S1 收尾后 |
| 0006 情绪动力学 | Draft | 先修状态饱和（bug 级） |
| 0007 检索骨架 | Draft | 需要 `evidence` 写入路径 |
| 0008 纠正检测 | **部分实现**（core 有、插件未更新） | 插件重装 + 重启 |
| 0009 schema 重设计 | Draft | 先定 `valid_until` 写入路径 |

## 环境与工具（新会话先看这一节）

| 东西 | 在哪 |
|---|---|
| **DSH profile（真机跑的那份）** | `D:\DSH\home\profiles\desktop`（`~/.dsh/profiles/desktop` 指向同一份存储）|
| 装进 profile 的包 | 上面 `node_modules/soulbridge`、`node_modules/dsh-plugin-soulbridge` |
| **重启 DSH** | `dsh-plugin-soulbridge/scripts/restart-dsh.ps1` |
| 重启日志 | `~/.soulbridge/restart.log`；取消用哨兵文件 `~/.soulbridge/restart.cancel` |
| 回滚插件 | `dsh-plugin-soulbridge/scripts/rollback.ps1`；profile 清单工具 `profile-manifest.ps1` |
| 结构体检 | `soulbridge/scripts/health-check.mjs` |
| 字段审计 | `soulbridge/scripts/field-audit.mjs` |
| **观察报告** | `soulbridge/scripts/observation-report.mjs`（只读，算 S1 四条判据的数据）|
| 真实数据 | `~/.soulbridge/soul.db`、`plugin.log`、`restart.log` |

**重启脚本的关键约束**：

- 它**必须由计划任务拉起**，不能直接从 app 里跑——桌面端把子进程放进 job object，脚本会跟 app 一起被杀
- 默认 `DelaySeconds=180`（等 3 分钟再杀进程），`-SoulbridgeHome` 可把它指向临时库做实验
- 连续启动失败会走 fallback：从 profile 里摘掉 soulbridge bundle，保证 app 还能起来
- `schtasks` 在 agent 沙箱里跑不了（会报 "The system cannot find the path specified"），所以**重启这一步要人来触发**

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

- 纠正检测：core 加 `detectCorrection`（规则 + 结构两层）+ 黄金集；插件 **0.0.32 已 overlay 并重启生效**，等第一次真实纠正落库
- **ADR 0026：生命感分层与降级**（L0 数据 / L1 注入 / L2 采样 / L3 生命周期 / L4 器官）—— L0/L1 是正确性前提，L2+ 只是增强
- schema 设计（[0009](briefs/0009-schema-redesign.md)）新增 L0 三件套：缺口 / 疤痕 / 时间感，都不依赖宿主能力
- 文档：新增 [briefs/0005](briefs/0005-eval-harness.md)–[0009](briefs/0009-schema-redesign.md)
- 工具：`scripts/health-check.mjs`（结构体检）、`scripts/field-audit.mjs`（字段审计）
- 索引：[docs/README.md](README.md) 是文档地图，先看它再决定读哪份
- 调研：[references.md](references.md) 里有 Harness²、OpenJudge/PawBench、Claw-Eval、digital-life-core 的读数

## 从哪看起

- 现在该做什么 → [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)
- 为什么这么做 → `docs/adr/`、`docs/rfcs/`
- 以后做什么 → [roadmap.md](roadmap.md)、[backlog.md](backlog.md)
- 怎么发版 → [runbook.md](runbook.md)
