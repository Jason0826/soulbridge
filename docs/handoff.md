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
| core | 0.0.25 | `turn_pairs` 存储（schema v4）；已 overlay 进 profile |
| dsh-plugin | 0.0.37 | 配对写入 `turn_pairs`（`turn/end` 为主，2s 静默兜底）；已 overlay 进 profile |

> `turn_pairs` 已在写（真机 2 行起），但 **pre-step 还在读 `memories`**——召回切换是下一步，也是唯一的行为切换点。

> 2026-10-31 overlay 前的旧版本备份在 `profiles/desktop/soulbridge-overlay-bak-20261031-150143`。

## 机制速览（都在跑）

| 机制 | 位置 | 说明 |
|---|---|---|
| 自动观察 | 插件 `session/event` | 每条用户消息 → `observe`：规则优先，漏了才问模型 |
| 注入 | 两层 | `systemPrompt.section` 放锚点（importance ≥8，≤3 条）；`agent/pre-step` **只注入 `<memories>`，无匹配则不注入**（0.0.34），日志带 `ids` |
| 工具 | `soul_recall` / `soul_remember` | **只有新建会话才看得到**（工具集在会话创建时固定） |
| 写入闸门 | core | shape → semantic → budget，`committed` 表示真的落库 |
| 纠正证据 | core + 插件 | `detectCorrection`（L1 规则 + L2 结构）；真机已有 **29 行**，但 `structural:negation` 精度约 **11%**（25/28 是否定词误判）→ 判据 3 只数 `rule:` 层 |
| 时效 | core | `validUntil` 过期不注入；`supersede` 是**手动 API**，没有业务调用者 |

## 已知问题（记在 backlog，未修）

- **affect 基本失灵**：`同事被裁员，内心空了一块` → `none`；`我不喜欢缩写` → `joy`（B4）。词表 75 词，真实句 7 个里 6 个零命中
- **不记日常**：只看长期事实/偏好，当前兴趣和近期事件不记（B1）
- 测试句和真实使用不可区分，靠 `测试：` 前缀约定
- **情绪状态已饱和**：`bond=2.0`（上限）、`tension=0.03`、其余四维从未变化 → "像朋友聊天"成了常量。设计见 [briefs/0006](briefs/0006-emotion-dynamics.md)
- **没有"证据等级"**：不知道一条记忆是用户原话、规则抽的，还是模型归纳的（[briefs/0007](briefs/0007-retrieval-scoring.md)）
- **schema 有死字段**：`visibility` 恒为 private、`vividness` 永不变化、`valid_until`/`superseded_by` 全 NULL。重设计见 [briefs/0009](briefs/0009-schema-redesign.md)

## 已排查：空回复 / 推理重复字（2026-10-31，结论已修正）

**现象**：某会话到 137 轮后，轨迹里出现大量重复字，最终文本为空；换新会话即恢复。

**已排除**（都有实测）：

| 假设 | 否定证据 |
|---|---|
| API 共用 / 限流 | 同账号同 provider 同模型，换会话不改变配额与路由 |
| 上下文太长 | `cacheRead` 增量 + `inputTokens` ≈ 1.5–7.4K token，离上限很远 |
| 记忆注入干扰 | `injectEnabled:false` 关掉注入后，同样的长输入**仍然空回复** |
| 内容触发（长引用） | 后续**短句也空**，说明与输入内容无关 |
| 我们的记忆被污染 | `turn_pairs` 共 35 条，assistant 为空的 **0 条** |

**真正的模式：会话历史自我强化。**

该会话 137 条记录里 12 条空回复，并且是递进的：

```
turn 108, 112          偶尔空
turn 127–137           几乎全空（9/11）
```

空回复被**持久化进会话历史**，模型随后看到"这轮对话里我从不回答"，就继续不回答。
新会话历史干净，所以恢复。

**怎么判定**：`~/.soulbridge/trace.jsonl` 的 `{"event":"message"}` 里的 `replyChars`。

> ⚠️ `replyChars=0` 也可能只是**工具调用步骤**（没有正文）。必须同时看那一步有没有 `tool/call`。

**处理**：一旦连续两轮空回复，直接换新会话或压缩，**不要继续对话等它自愈**——历史只会更脏。
**未解**：第一次空回复的触发条件（turn 108 之前发生了什么，数据不足）。

## 设计债（2026-10-31 更新）

**设计仍然跑在实现前面**：`briefs/0005`–`0010` 除 0008 外全是 Draft，没有一行实现。
这不是问题，但要记着——**声明多于能力时，最容易高估自己**。

| 设计 | 状态 | 前置条件 |
|---|---|---|
| 0005 评估 harness | Draft | 需要消费者；S1 收尾后 |
| 0006 情绪动力学 | Draft | 先修状态饱和（bug 级） |
| 0007 检索骨架 | Draft | 需要 `evidence` 写入路径 |
| 0008 纠正检测 | **已实现**（core + 插件 0.0.33 起） | 精度待修：`structural` 仅约 11% |
| 0009 schema 重设计 | Draft | 先定 `valid_until` 写入路径 |
| 0010 记忆单元 | Draft | 先定 `turn_pair` 落地 + 归纳 |

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

**S2 未开工，但效果目标已定：[MVP1](mvp.md)——关掉再打开，它能接上上次聊的。**

按阶段规则 1，开工前先写 S2 阶段文件，效果目标引用 MVP1。

MVP 顺序**不能跳**：MVP1 交流记忆 → MVP2 画像 → MVP3 触发动作。
（MVP1 之前也讨论过"记忆召回后触发动作"，那是 MVP3，现在做没有地基。）

当前状态：

1. core 0.0.24 / plugin 0.0.34 已 overlay 并重启生效——**全是 bug 修复，没有新功能**
2. `prestep` 日志开始带 `ids`，判据 2 **第一次可回溯抽查**（等几天数据）
3. [0010](briefs/0010-memory-unit.md) 定义了条目与注入分工，**未实现**

**MVP1 需要 `turn_pair` 落库**（0010 §4），所以 S2 的第一步是写它的 RFC，不是改代码。

## 最近变化（2026-10-31）

- **BM25 检索**（core 0.0.24）：`relevance` 从命中比例换成 IDF + 长度归一化。真机 60 条记忆 / 298 条 query：那条 18202 字的进入 top3 的比例 **85% → 15%**，top1 平均 12150 → 1099 字
- **S1 提前收口**：判据 2 无法抽查、判据 3 数据源精度 11%。收尾记录见 [stages/s1-dsh-memory.md](stages/s1-dsh-memory.md)
- **注入修复**（plugin 0.0.34）：无匹配不再注入 88 字符空块；只注入 `<memories>`，不再重复 `<soul>/<style>`；日志带 `ids`
- **判据 3 统计口径**：只数 `rule:` 层（`structural:negation` 约 11% 精度）
- **0010 记忆单元**：`turn_pair` + 三轴 + 注入分工（设计，未实现）
- 本次之前的记录（2026-10-30）：纠正检测、ADR 0026、0009 schema、工具脚本

## 从哪看起

- 现在该做什么 → **S2 未定**，见上面"下一步"
- 当前设计 → [briefs/0010](briefs/0010-memory-unit.md)
- 为什么这么做 → `docs/adr/`、`docs/rfcs/`
- 以后做什么 → [roadmap.md](roadmap.md)、[backlog.md](backlog.md)
- 怎么发版 → [runbook.md](runbook.md)
