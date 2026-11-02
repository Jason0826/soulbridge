# 状态对照表（设计 ↔ 代码 ↔ 实测）

> 用途：**让你能核对我的理解**，而不是听我复述。
> 每一行都有出处：设计在哪、代码在哪、数字怎么来的。
> 权威性：代码 > 本表 > 我的口头总结。发现不一致时，以代码为准并改本表。

最后核对：**2026-11-03 00:35**（core 0.0.82 / plugin 0.0.92）

> 文档有效性见 [README.md](README.md)。本文只记"设计与实现的对照"。
> 流程规范：[process.md](process.md)（十步，每步有判定方式）。
> 旧表示退场登记：[retirements.json](retirements.json)（`health-check` 第 7 节判定）。`n> 名词/变量声明：[declarations.json](declarations.json)，定义文件在 `packages/core/src/config/`（`health-check` 第 8、9 节）。
> 全系统审计：[audit/2026-11-02-whole-system.md](audit/2026-11-02-whole-system.md)。
> 代码审查（今晚，含已修复 4 条）：[audit/2026-11-02-code-review.md](audit/2026-11-02-code-review.md)。

**00:35 修复摘要**：WAL 备份改为 `VACUUM INTO` + 完整性校验，坏备份挪走并拒绝升级（备份从"有"变成"有效"）。core 247 测试。`n`n**00:20 修复摘要**：实体刷新不再清空别名与属性（别名累积、属性合并），`latestAbout` 刷新后仍能按别名命中。core 246 测试全过。`n`n**00:05 修复摘要**：`distill` 开关退役，`extract` 成为唯一模型开关；无模型时分类/归纳不再入队（避免 cap 丢新项）。distill 退场项翻成 done。`n`n**23:40 修复摘要**：`section` 不再带 `<affect>`（每轮变的值会让 DSH 每轮追加一个 prompt 版本）；core 新增 `includeAffect` 开关，affect 仍走每轮消息通道（core 242 测试 / 插件 70 测试）。`n`n**23:15 修复摘要**：插件侧模型失败不再被当成"模型说没有"——失败即抛错、归纳草稿读不出来退队重试、验证阶段 3 次上限（插件 68 测试全过）。`n`n**22:50 修复摘要**（详见代码审查第六节）：检索路由的三处误判、合并 prompt 示例与闸门不一致、
正反句被折叠、JSON 形状抽取被空 operations 遮蔽。core 241 测试全过；
`scripts/review-probes.mjs` 前 5 段从红变绿。

**退场账**（23:00）：已退场 3 项（turn_pairs 写入、handoff.md、review.mjs），
技术债 4 项（memories 写入、distill 开关、锚点容器、JSON 抽取形状）——
每一项都在 `docs/retirements.json` 里，清干净就翻成 done，复活就 FAIL。

**唯一声明**（23:00）：维度名与准入定义收进 `dimensions.ts`，两个 prompt 与示例改为渲染，
副本清零；`superseded` 还有 3 处副本（SQL 字面量，改之前要先解决参数绑定，见 declarations.json）。
登记在 `docs/declarations.json`，`health-check` 第 8 节判定。

## 一、当前架构（一句话）

```
轮次（turns/steps）→ 事实（facts/fact_slots/entities/gaps）→ 线索（threads）→ 判断（规则 | 画像）
```

判断分三层（ADR 0033）：**规则**按触发注入、**画像**按维度注入、**记忆**按预算注入。
每层都有确定性闸门；模型只负责语义，失败有地板（ADR 0031）。

## 二、今晚新增的四条链路（2 小时内的改动，已上线）

| # | 链路 | 状态 | 证据 |
|---|---|---|---|
| A | 画像按维度切分合并（0021） | ✅ | 合并输入 9 → 1（派生行不再进输入）；228 测试 |
| B | 分类 → 维度 → 画像队列 | ✅ | 分类输出 `维度=`，`markProfile` 写槽并入队；231 测试 |
| C | T1 升格（纠正轮 → 候选） | ⚠️ 机制通、信号不准 | e2e 测试通；但纠正检测 precision 约 1/3 |
| D | 队列 IO 合并（4 套 → 1） | ✅ | 63 测试；review WARN 4 → 3 |

## 三、设计与实现对照

| # | 设计（出处） | 代码事实 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 一轮是完整往返 `0010 §4` | `turns` + `steps`；`turn/end` 触发 | **256 轮 / 984 步** | ✅ |
| 2 | 推理存但不注入 | `recordTurnPair({steps})`；召回只读正文 | reasoning 块入 steps | ✅ |
| 3 | 抽取=模型填表+闸门 `ADR 0029` | `renderExtractionPrompt` + `validateDraft` | **99.3%** 走模型 | ✅ |
| 4 | 不记对话动作 `0016 §4` | prompt 的四类 `<when-to-write>` | 请求类产出 facts=0 | ✅ |
| 5 | 话题是线索（A B A）`0017` | `threads` + `applyThread` | 83 线索；**新开率 88.4%** | ⚠️ 接不住旧的 |
| 6 | 线索按空闲轮闭合 `0017 §4.3` | `closeIdleThreads` | 默认 6 轮 | ✅ |
| 7 | 归纳按线索 `0017 §4.4` | `threadContext` + 两阶段 | 结论支持率 100%（7/7） | ✅ |
| 8 | 结论=事实+≥2 证据 `ADR 0031` | `recordConclusion` / `conclusionSlots` | 7 条结论 | ✅ |
| 9 | 系统提示只放稳定内容 | `section` 88 字符 | 无抖动 | ✅ |
| 10 | 动态记忆走消息通道 | 锚点 + `<about>` + `<related>` + `<handoff>` | 注入 1.9–5.4KB | ✅ |
| 11 | 上次聊到哪 = 上一闭合线索 `0017 §4.5` | `lastClosedThread` + `renderHandoff` | **仍未被跨会话触发** | ⏳ |
| 12 | 情绪读出用户状态 | 词典 `analyzeAffect`（模型未接） | **2.4%**（13/540） | ❌ |
| 13 | 可携带（导出契约）`ADR 0028` | **无导出实现** | — | ❌ |
| 14 | 行为影响（记忆改变行为） | 无（0018 挂起） | — | ⏳ |
| 15 | **三层：规则 / 画像 / 记忆** `ADR 0033` | 规则 62 / 画像 9 / 记忆 120 | 三层都在注入 | ✅ |
| 16 | 规则按触发注入（不常驻） | `selectRules` + `<rules fired=…>` | 触发过 **12/62（19%）** | ✅ |
| 17 | 画像按维度注入 `ADR 0021` | `selectProfileFacts`（core + facet） | 9 条，**4/7 维**，可追溯 8/9 | ✅ |
| 18 | 合并按维度切开（今晚） | `groupProfileCandidates` + `mergeableGroups` | 输入 9→1，跨维度输出被拒 | ✅ |
| 19 | 派生 = 引用了来源（今晚） | `isDerivedProfileLine` | 8/9 条派生行不再进合并输入 | ✅ |
| 20 | 分类是队列的唯一活水（今晚） | `markProfile(dimension)` → `enqueueProfileCandidate` | 队列现为 0 条（无新教训） | ✅ 机制 / ⏳ 数据 |
| 21 | T1：纠正才升格（今晚） | `wasCorrectedTurn` + `promotionCandidates` | e2e 通；**信号 precision ~1/3** | ⚠️ |
| 22 | 候选 / 生效 / 撤回 | `facts.status` 只有 `none`/`superseded` | "候选不生效"**无处表达** | ❌ |
| 23 | 老 `memories` 退场 | 只剩 **2 行**；写入路径仍在，锚点仍读 | 数据近空、代码未删 | ⚠️ |
| 24 | 冻结层清理 | `turn_pairs` **97 行、0 写者** | 无写入、只有迁移在读 | ⚠️ |

## 四、四个比率（`node scripts/quality.mjs --days 7`）

| 指标 | 值 | 通过线 | 判定 |
|---|---|---|---|
| 事实密度 | **0.64 条/轮**（165 / 256） | ≤1.5 | PASS |
| 抽取走模型 | **99.3%**（147/148） | ≥80% | PASS |
| 结论支持率 | **100%**（7/7） | ≥80% | PASS（样本仍小） |
| 情绪非零率 | **2.4%**（13/540） | ≥50% | **FAIL** |

口径：按轮去重（重试不算独立跑）、无 `reason` 的旧记录算"未测量"。

## 五、新算出的观察值（今晚第一次，暂无通过线）

| 观察值 | 数 | 读法 |
|---|---|---|
| 无实体锚点 | **92.7%** | 事实里 93% 没有参与者——世界层几乎是空的 |
| 线索新开率 | **88.4%** | 88% 的轮次开新线索，几乎不接旧的 |
| 归属覆盖率 | **34.4%** | 三分之二的轮次没有线索 |
| 规则触发率 | **12/62（19%）** | 其余 50 条未触发（不全是无效，部分是低频） |
| 纠正来源 | 结构层 74 / 关键词 16 | 关键词只抓 17%；结构层抽样 precision ~1/3 |
| 升格率（旧数据） | 128 条教训 → 61 条规则（48%） | 每条只出现一次就升格，门槛过低 |

## 六、已知缺口（按优先级）

| # | 缺口 | 影响 | 在哪 |
|---|---|---|---|
| 1 | **情绪读不出** 2.4% | 语气恒定 | 词典 vs 模型 |
| 2 | **纠正检测不准**（precision ~1/3） | 一切基于 corrections 的比率不成立 | `detectCorrection` |
| 3 | **没有候选态** | 判断一写就生效，T1 的"待核"无处表达 | `facts.status` |
| 4 | 线索太碎（新开 88.4%） | MVP1"接得上"直接受影响 | 归属 prompt |
| 5 | handoff 未真实触发 | 跨会话续聊未验证 | 需新会话 |
| 6 | 世界层空（无实体 92.7%） | "她最近怎么样"没有数据 | ADR 0032 未落地 |
| 7 | 导出契约未实现 | 换机器/换工具带不走 | ADR 0028 第 3 条 |
| 8 | 冻结层未清 | `turn_pairs` 无写者；`memories` 写入路径未删 | 审计第二节 |
| 9 | 插件单文件 2223 行 | 11 种职责混在一起 | 审计第六节 |

## 七、文档状态

| 文档 | 状态 |
|---|---|
| `state.md`（本文） | ✅ 已更新到 22:05；`health-check.mjs` 4.7 会比对它与代码最后提交，落后就 WARN |
| `audit/2026-11-02-whole-system.md` | ✅ 8 次改动各自缺的 review、5 条结构缺口、收敛顺序 |
| `roadmap.md` | ✅ 已按本文缺口重写（R1–R5），旧编号 N0–N3 作废 |
| `mvp.md` | ✅ 状态列已改；判据未动 |
| `handoff.md` | 🗑 已删除：两份"现状态"必然互相过期，只留本文 |

## 八、怎么自己核对

```powershell
cd D:\git-workspace\repos\soulbridge

node scripts/health-check.mjs        # 全系统：规模/测试/声明/文档/结构漂移（唯一入口）
node scripts/quality.mjs --days 7    # 四个比率
node scripts/rule-stats.mjs          # 规则总数与触发覆盖
node scripts/profile-coverage.mjs    # 画像维度覆盖与可追溯
node scripts/health-check.mjs        # 结构体检（含本文版本表是否与 package.json 一致）
node scripts/verify-installed.mjs    # 装上去的产物是不是这份代码
```

## 八之二、环境与工具

| 东西 | 在哪 |
|---|---|
| 重启 DSH | `dsh-plugin-soulbridge/scripts/restart-dsh.ps1`（必须由计划任务 `DshRestartOnce` 拉起，120s 延迟） |
| 重启日志 | `~/.soulbridge/restart.log` |
| 插件日志 / 轨迹 | `~/.soulbridge/plugin.log`、`trace.jsonl` |
| 真实数据 | `~/.soulbridge/soul.db` |
| 线索验收 | `scripts/abba-check.mjs --topic <词>` |
| 队列文件 | `pending-extract / pending-classify / pending-profile / pending-threads.json` |

## 八之三、踩过的坑（每一条都真踩过）

| 坑 | 结论 |
|---|---|
| 用时间猜轮次边界 | 轮的边界是 `turn/end` 事件，不是静默 |
| 宿主 `turn_no` 当轮次计数 | 它每次用户发言跳 10–30，**要数 turns 行** |
| 用实体名兜底 | 不认识的名字仍然是主体，不能落到"上次聊到哪" |
| 用 `type_name` 分类 | 16 种标签碎片化；结构（holder + 时间）才是分类 |
| 中文全文检索 | FTS5 的 trigram 搜不到 2 字词；用二元分词 |
| PowerShell 改代码 | 模板字符串会被吃掉、`\n` 变字面量；**用 edit 工具** |
| 改完就重启 | profile 装的是**副本**，必须先 `verify-installed.mjs` |
| 把测试跑通当 review | 局部验收 ≠ 整体一致，见审计第七节 |

## 八之四、约定（必须遵守）

1. 改动前解释：为什么、怎么做、影响
2. 需求说明 → 文献 → 边界 → 声明 → 验收
3. 改动前后各跑一次 `health-check.mjs`，输出要贴进交付物
4. 发版前 `npm test` fail 0，且 `verify-installed.mjs` 通过
5. 失败排查先保存原始输出，不猜
6. 报数据，不报感觉


## 九、我说错过的判断（供你校准）

| 我说过 | 实际 | 错在 |
|---|---|---|
| "抽取走模型只有 52.9%" | 按轮去重 90.9%，现在 99.3% | 指标写错：重试被当成失败 |
| "情绪一写就立刻影响这轮语气" | pre-step 在提示词组装之后 | 没读 agent-loop 时序 |
| "让模型输出 JSON 是可行的" | 54 字符被丢两小时 | 把格式契约押在 hope 上 |
| "注入是空回复的诱因" | 关掉注入仍复现 | 单次实验就下结论 |
| "两套记忆并存（81 条还在写）" | `memories` 只剩 **2 行** | 拿旧数字说话，没看库 |
| "87 条纠正可用作指标" | 92 条里 80% 来自否定词结构层，抽样 precision ~1/3 | **没有抽样验证就开始算比率** |
| "四个队列各自实现，改起来乱" | 对，但同一 bug 在三处各修一次才是真代价 | 说对了现象，没给代价 |
| 八次改动都做了验收 | 只做了局部验收（测试/条数/日志），没做整体 review | **把"跑通"当成了"review"** |
