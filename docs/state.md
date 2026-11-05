# 状态对照表（设计 ↔ 代码 ↔ 实测）

> 用途：**让你能核对我的理解**，而不是听我复述。
> 每一行都有出处：设计在哪、代码在哪、数字怎么来的。
> 权威性：代码 > 本表 > 我的口头总结。发现不一致时，以代码为准并改本表。

最后核对：**2026-11-06 05:20**（core 0.0.117 / plugin 0.0.120）

> 文档有效性见 [README.md](README.md)。本文只记"设计与实现的对照"。
> 流程规范：[process.md](process.md)（十步，每步有判定方式）。
> 旧表示退场登记：[retirements.json](retirements.json)（`health-check` 第 7 节判定）。
> 名词/变量声明：[declarations.json](declarations.json)，定义文件在 `packages/core/src/config/`（`health-check` 第 8、9 节）。
> 全系统审计：[audit/2026-11-02-whole-system.md](audit/2026-11-02-whole-system.md)。
> 代码审查（今晚，含已修复 4 条）：[audit/2026-11-02-code-review.md](audit/2026-11-02-code-review.md)。

## 接手须知（新会话先读这一段，约 1K 字符）

```
现在在做什么   0028 实施③ 完成、发版部署中（core 0.0.117 已升版；插件 0.0.121 排队）：
               归属输出扩多条线索（spans），段内每轮挂线。之后 = §九④ §八 四行真实重放
已验证         ③ spans：core 321 / 插件 122 测试全过；变异：去范围解析→恰 1 红、
               fan-out 只挂头轮→core 5 红 + 插件集成 1 红（真模型路径：两行线索 → 两条线索、
               每轮挂上、线索记真实轮号）；两个真 bug 是测试先抓的（首行吞段、new 逐轮开克隆）
② 仍有效：检查表 planSegment（压缩标记/会话切换·归档/容量40轮·6万字/年龄24h，纯函数表驱动）
               + 段 sealing：插件 120 测试全过；变异：去标记→恰1红 / 绕过无触发闸门→6红 / 去封存→恰1红
               会话中抽取 = 0 by construction（无触发只留 segment-wait；入队日志改 extract buffered）
               ① 仍有效：core 314 / 插件原 107；handoff 还原变异恰好 1 红 → 恢复绿
               提醒换会话：插件按会话累计 turn-cost，每请求上下文 ≥300k 或 ≥100 轮 → 注入
               <switch-session turns=… context-per-request=…>（由模型转告），每跨一级一次
               首次真实触发：10:06:51 turn=17，turns=1 · 469,028/req（账本从 09:53 重启起算）
               取舍可见的真实样本（01:45–01:47，模型两次 model-failed 时规则兜底）：
               draftSkipped=1，丢的是「加一个提醒换新会话的功能」(no-structure)
               —— 用户自己的请求句，在模型失败时不会变成事实，以前无声消失，现在有记录
               每轮成本（七日内 39 轮）：平均 21.9 次请求 · p50 6 · p90 49 · 最重 271；
               分布 1-5:19 / 6-15:11 / 16-30:2 / 31+:7；每请求上下文 355,311 token（纯输入仅 4,516）
               写入侧一个语法一个日单位：规则抽取改走 findTimeExpression，日历日 = UTC 零点
               day/range 非日历日 2 → 0（quality.mjs 观测 PASS）；时间检索实跑：上周窗口 2 条 day/range 进窗
               取代引用 50 成 / 1 败 → 2% PASS
下一步         1) 0028 实施（§九 顺序；① ② 已上线，③ 完成待部署验证——core 321/插件 122、双变异红）：
               ④ §八 四行真实重放（手动 /compact 当天验，③④ 一起补 A9 review）→ ⑤ retirements 登记
               ②的整体 review：audit/2026-11-05-review-departure-checklist.md（① 的在 floor-cost-handoff）
               2) 子代理的请求要不要滚到父轮 —— 需要 DSH 暴露会话谱系，事件流里没有
               3) 0027 §八 剩余三个读者：注入措辞 / 排序比较 / soulbridge why 打印 precision
               收口余债（见 0027 §十）：TIME_CUE 与语法词表两份、calendarDate/parseIsoDay 两份、
               facts(since/until) 还能不带 precisions 调用
不要做         抽取输入上限 —— 用户明确否决（751 次里只有 1 次超 6 万字符）
不能忘         抽取单位 = 离开点切出的段（线索归属是抽取的产物，0028；队列在等=正常，segment-wait 可查）
               自包含闸门只对 holder 生效；事实必须写轮次
               **时间：created_at 代码写 / valid_from·valid_to 模型判定**（断言=说出口那天成立；
               valid_to 绝不从 valid_from 推导）。字段名不要用 at/at_end/valid_until
               **日历日只有一种存法：UTC 零点**（该表达式所在本地日历日）——窗口、规则抽取、显示同一单位；
               别用 date(<epoch秒>) 转日期：这个 SQLite 把数字当儒略日
               **时间窗口只信 day/range**：unknown 的 valid_from 常是「记下那天」，进范围查询就是 v14 同类错误
               成本不是记忆层的事：core 里没有一行价格逻辑，账单脚本在插件仓库
最近成本       11/01–11/04 = ¥100.22；6,028 次请求，¥0.0166/请求（数字来源见下）
               金额构成：输入命中 56.3% / 输入未命中 23.3% / 输出 20.1%
               最重单轮 271 次请求（4973730c/turn15）；平均 21.9 次/轮（七日内 39 轮，quality.mjs --days 7）
关键文件       docs/briefs/0028-departure-flush.md（写入时机设计，当前权威；§十 四项已拍板、§九 实施序）
               docs/briefs/0025-thread-extraction.md（§二/§三 已被 0028 取代；§四·一/五/九 仍有效）
               docs/briefs/0027-time-axis.md（§八 读取方 / §九 实施 / §十 写入侧收口）
               packages/core/src/{time,retrieval,extract,prompts,sqlite,index}.ts
               D:\git-workspace\repos\dsh-plugin-soulbridge\index.js
               账单与判读：dsh-plugin-soulbridge\scripts\billing.mjs · docs\cost-visibility.md
环境           固定端口 3080；重启 = `Start-ScheduledTask DshWebRestartOnce`（90s 延迟、脱离
               agent 的 job 对象跑 restart-web.ps1）——**直接在会话里跑脚本会被宿主连坐杀掉**
               （22:33 实测：Job runner 报错、重启根本没发生，宿主毫发无损）
               运行中的 profile = ~/.dsh/profiles/web（→ C:\DSH\home\profiles\web）
               发版 = 推 tag → GitHub Actions → npm（当前 core 0.0.117 / plugin 0.0.120）
               注意：npm 读侧复制延迟实测 3–15 分钟，`npm view` 马上查会 404，别判成发布失败
成本导出       D:\Download\usage_data_*.zip（平台导出，含 amount/cost 两个 CSV）
```

## 会话交接（换会话时重写，最多 6 行）

> 为什么单列一节：接手须知回答"现在是什么状态"，但不回答"上一个会话走到哪、为什么、还热着什么"。
> 新会话只读状态会像换班工人；这 6 行是**叙事**，不是状态——换会话时整体替换，不累积。

```
上一段   2026-11-05 21:25–（session-1d060599，接 a1cca035），core 0.0.116 / plugin 0.0.120
做了     0028 实施②：planSegment 四触发检查表 + 段 sealing + 失败段语义，旧按线索解析
         drain 与 pickExtractionItem 同批退场；发版部署到 profile（22:35 条目全链路）
验证     插件 107→120 测试；变异三组（去标记 1 红 / 绕闸门 6 红 / 去封存 1 红）；
         前提实证 payload 与事件 session id 同键（sessionLedger 对账）；npm 0.0.120 →
         pnpm 11 装 profile → verify-installed 6 PASS → apply() (v0.0.120) @ 22:33:06 实测
没做完   segment 首批真实样本（extract buffered/segment-wait 随重启后首轮出现、flush 等离开点）；
         0028 ③ 多归属 ④ §八 重放（手动 /compact 当天验）⑤ retirements；
         quality 三条 FAIL 待查（密度段级复测 / 结论证据链 / 情绪非零率）；handoff 重启重发待定夺
在热什么 队列在等不是坏了（无触发=正常，segment-wait 可查）——会话中抽取=0 是闸门不是自觉；
         seed-backfill 仍绕写入器、reset 不清 seals（⑤ 一并）；换会话前先看 switch-session
```

**05:20 0028 实施③完成，发版部署中（core 0.0.117 升版）**：归属输出扩多条线索——格式 `线索: <起>-<止> 继续 <id>` / `新 | 主题`（**无范围 = 整段**，单话题行逐字兼容；裸数字 = 单轮；`5-` = 到段尾）；`ExtractDraft.thread` 单条退场 → `spans?: ThreadSpan[]`（types +20 / extract +38 / index +63，棘轮 core +121、插件 +32 两条 history 已记）。`readThreadSpans` 多行解析，三态观测（present/absent/invalid）保留、坏行仍可查；**开放端收口**——多行时没写止的段停在下一条线索之前，否则 find-first 永远走不到后面的行（设计 bug，测试先抓）。`applyThreadSpans` 逐轮复用 `applyThread`（继续-新 / fallback-previous / 无候选兜底链一字不动，ADR 0034）：**段内 new 只开一条**（第 1 轮开、其余接上——逐轮开同话题克隆正是 0028 要消灭的碎片化，测试先抓）、**未覆盖轮链到前一轮**、**每一轮都挂线**（修掉旧实现只挂头轮的缺口——handoff / 候选原文 / 归纳看到的段不再有洞）。双编号显式传递：提示词 1..n 管范围匹配、真实轮号（宿主跳 10–30）管线索计数，drain 带 `hostTurnNo` 不猜。插件日志：单线索保持旧格式 `thread=th_xxx(new)`；拆段列全 `thread=a,b(2 new)`、`join=` 改为逐轮原因并集（一致时仍单值——**口径变更**：头轮不再代表全段）；trace 拆段时带 `threadSpans` 逐轮明细（错切可诊断）。提示词 schema/rules 教范围语法（+269 字符，提示词上限 5450→5600 按惯例记账）。测试 core 314→321 / 插件 120→122；变异：去范围解析恰 1 红、fan-out 只挂头轮 core 5 红 + 插件集成 1 红。**流程记录（下次照做）**：core 未发版前插件测试要本地叠层——在 core 仓 `npm run build` → 拷 dist 进插件 `node_modules/soulbridge`（runbook §八 同法；发版后 `npm install` 按 lock 回退，需装已发布版重同步）；期间一次 `npm run build` 跑在插件目录（无 build 脚本）造成叠层假阴性——**确认 build 在 core 仓跑**。

**22:35 0028 实施②完成并部署（插件 0.0.120，运行层已验）**：触发检查表 + 段 sealing 全链路——`planSegment` 纯函数承载四触发（**压缩标记 / 会话切换·归档 / 容量 ≥40 轮或 ≥6 万字 / 年龄 >24h**；前两个是语义离开、后两个只当工程兜底，quiet-time 结论写进代码结构），`compaction/end` 无 error 才置标记（error=窗口没变，留标记会把还在上下文里的内容写成持久记忆），drain 无触发只留 `segment-wait` 观测（**会话中抽取 = 0 by construction**，入队日志改 `extract buffered`），触发后整段一次抽（unit=Nturns，提示词轮次 1..n 经 turnIds 映射回真实 source_turn_id）→ 成功写 seal（`segment-state.json` ≤100 条可查、超限有日志、损坏挪走不判空）→ `enqueueExtraction` 拒已封存轮（`origin=backfill` 是记录在案的重放例外）；失败整段同 bump（一次调用覆盖它们），第 3 次 `given-up:` 封存丢弃（带段大小）。按线索解析的旧 drain 路径与 `pickExtractionItem` 同批退场（时序倒置根因本体，见 18:05 条目；live-first 防的饥饿被段语义化解——20 条回填等一次调用不是二十步）。**前提实证（不是假设）**：drain 拿的 `payload.agent.id` 与事件 `session.id` 同键——`switch_session`（payload 侧）与 `turn-cost`（事件侧）记的是同一个 sessionLedger，10:06:51 的换会话提醒能触发即证明两键相同（若不同键，due() 永远新建空账本、提醒永不触发；trace.jsonl 两边格式均 `session-<uuid>`）。测试 107→120；变异三组：去标记→接线恰红 1、绕过无触发闸门→6 红、去封存→恰红 1；promote.test 窗口 3000→4500（检查表插在签名与接线之间，被断言的字面全文件仅一处）。棘轮 +236 按 0026/0027 功能先例记 history（同期删旧路径 -70 余行）→ `--update-budget` 3051 → health-check 0 FAIL / 18 WARN / 25 PASS。发版链路：core typecheck+test 0 红 → `v0.0.120` → release #109 success（22:15:18Z）→ npm 0.0.120 实测可见 → pnpm 11 装进 web profile（**坑：corepack 拉的 pnpm 12 会把 9.0 lockfile 重写、store v11/v10 不匹配要 ERR_PNPM_UNEXPECTED_STORE——用 `corepack prepare pnpm@11 --activate`**）→ manifest/node_modules 双确认 0.0.120 → **verify-installed 6 PASS**（core 0.0.116 / plugin 0.0.120）→ DshWebRestartOnce 22:31:13 触发（90 秒延迟，直接跑 restart 脚本会被宿主连坐——22:33 前实测）→ 22:32:56 停 / 22:33:01 起 → **`apply() called (v0.0.120) @ 22:33:06`**。segment 首批样本：重启后首轮 turn/end 才入缓冲（`extract buffered`），首个 flush 要等离开点——归 ④ 重放验收。**重启附带发现**：`handedOff` 是进程内 Set，重启即清空，同一会话会再收到一次相同 handoff（本会话 21:25、22:33 各一次）——决定 4 的「每会话至多一条」在重启边界实际按「每进程」计；重发无害但要说清，归 ④ 或 ⑤ 决定持久化与否。质量比率（runbook 0.6，三条 FAIL 原因写明）：事实密度 2.2/轮 FAIL——段级一次多条+回填所致，②后会话内抽取=0 应下降（待复测）；结论支持率 65.1% FAIL——归纳证据链已知债；情绪非零率 2.2% FAIL——affect 层待查；抽取走模型 99.2% PASS。②的整体 review：[audit/2026-11-05-review-departure-checklist.md](audit/2026-11-05-review-departure-checklist.md)（判通过，四条发现：rules floor 对段只看末轮 / seed-backfill 仍绕写入器 / reset 不清 seals / 重试窗口段尾同计数）。

**21:20 0028 实施①部署完成（插件 0.0.119）**：两件小修上线——① handoff 消费抽成导出工厂 `createHandoffTaker`：**空读与抛错都不再消费**会话的一次性（旧写法第一注入读空就永久跳过，0028 决定 4 的前提），3 条契约测试，变异还原无条件消费恰好 1 红；② 日志前缀 `extract ok:` → `extract done:`（`rules:model-failed` 不再谎报成功，10:01 重启是新旧前缀分界）。全链路（全部实测）：插件 107 测试 → 棘轮 +24 按先例记 budget history、`--update-budget` 重写 2815 → `v0.0.119` 发版，npm 20:53:35Z 实测已发布 → profile 装 0.0.119 → `verify-installed` 6 PASS/exit 0 → `DshWebRestartOnce` 21:01 重启 → **`apply() called (v0.0.119) @ 21:01:05`，21:15:57 handoff 真实发出**（"SeeCode 落地留存…" summary=yes，inject handoff=yes turn=15——你回来时看到的那段交接块就是新代码发的）。A9 整体 review 补齐：[audit/2026-11-05-review-floor-cost-handoff.md](audit/2026-11-05-review-floor-cost-handoff.md) 覆盖 4 个待 review 业务提交（时间语法 / 取舍可见 / turn-cost / handoff）。重启前 19:52–20:41 四条抽取再次全 `unit=1turn join=continue`——0028 ② 要修的现象稳定复现中。

**20:45 0028 四项拍板，转 Ready（仍只动文档）**：§十 关闭——① 规则层**不保每轮、跟着段走**（同调用内规则与模型二选一、一次 commit 一个写入者，不冲突；近义重复靠段输入明列已有规则事实 + 完全重复闸门；代价：会话中的「以后别 X」下会话才成 fact，同会话靠上下文）；② 手动 `/compact` **实施当天验**（自动链路已实测 12 次）；③ handoff **自动发**——门牌自动（每会话至多一条非空）、门内 `soul_detail` 按需（依据：`soul_recall` 主动调用 0 次，按需=永不发生；核桃验证证明自动路径端到端有效）；④ 延迟**认 1 轮**，取数口径改为段状态（决定 4 补口径），第 1 轮由 `<related>` 原文兜底，不用同步等 flush（10–95 秒阻塞不值）。接着开实施 §九 ①：两件小修。

**20:02 brief 0028 离开点抽取（设计定稿，未动代码）**：把 18:05 的根因收敛成一页设计。第一原理——**抽取是为「离开上下文之后」做的备份，在上下文里宿主原生就记得，抽了是重复**——所以触发点 = 离开点：压缩（`compaction/end`，plugin.log 实测 12 次，插件已订阅）/ 切会话·归档（`archivedSessionIds` 在用）/ 容量超限 / 年龄 24h，**全部在下次开口的 drain 里做确定性检查**（模型只能在 step 内调用，无后台定时器）。五决定：① `turns` 不可变是唯一真相，facts/线索/归属/结论全是可重放的派生投影；② 写入只在离开点，会话中 LLM 抽取 = 0；③ **归属是段抽取的产物**（段内多话题由模型一次切开，时间信号永远不产生归属）；④ handoff 是渲染不是触发（空不消费、拿到即止）；⑤ 注入分常驻（画像）与按需（hook + `soul_detail`）。0025 §二§三、0017 归属时机、ADR 0034 指标口径已打修订注（原文保留），README 权威表加行；health-check 改前改后 0 FAIL。四个开放问题见 0028 §十，实施顺序见 §九。

**18:05 unit=1turn 的条件查清（观测，未改代码）**：判据是 `turns.thread_id`，唯一写者是 `attachTurn`（`sqlite.ts:1345`），生产路径只由 `applyThread` 在**该轮抽取结束时**写入（插件 `index.js:1486`）；而队列 drain 在抽取**开始前**读 `turnThreadId`（`index.js:1611`）——**查在线索写入之前，时序相反**。于是：① 直播轮首次抽取必 `1turn`（归属还没发生）；② 首轮 outcome 非 ok（`rules:model-failed`，规则 floor 已把归属写掉、轮次留队）时，**重试才拿到线索**。`unit=` 上线（11-04 18:40）以来 46 条日志实测：`1turn` 42（全 live；join=continue 36 / explicit-new 4 / fallback-previous 2——**38 条接进了已存在的线索，却按单轮抽**）；Nturns 仅 4（26turns×2、46turns×2，**全部是 model-failed 重试**：46turns 三次全败被丢弃，26turns 第 3 次才拿到 llm 15 条事实）。结论：0025 §三 的触发条件（按 threadId 入队、线索关闭或 ≥6 轮增量才抽、同线索合并）**没实现**，实际是"按轮入队 + drain 时解析线索"，而解析依赖的字段要等这次抽取结束才存在——**整线索抽取在直播里首次从不生效，目前全库只有 1 个整线索成功样本**（26turns/15 facts）；backfill 轮次先归属再入队应为 Nturns，日志 0 样本、待验证。附带发现：`extract ok:` 前缀误导——`rules:model-failed` 也打 `ok`（日志的 ok ≠ 队列完成）。修法已收敛为 brief 0028（见上 20:02 条目）。

**10:07 提醒首次触发 + 取舍可见的首个真实样本（插件 0.0.118）**：`switch-session: remind turn=17`（10:06:51），注入 `<switch-session turns="1" context-per-request="469028">`——账本从 09:53 重启起算，一轮就过了 300k。更早的同一天（01:45–01:47），模型连续两次 `model-failed`，规则兜底把「加一个提醒换新会话的功能」和「需要换session吗」判为 `no-structure` 丢弃：**用户自己的请求句，在模型失败时不会变成事实**——以前无声消失，现在有 `draftSkipped=1` 和丢弃原因。这正好画出"地板"的边界：规则只认人/动词/时间，请求类句子只能靠模型。

**09:50 提醒换会话（插件 0.0.118）**：`turn-cost` 同一条记录现在也回答"这个会话还能不能继续开"。插件按会话累计（轮数/请求/三类 token），当**每请求上下文 ≥300k**（历史会话 420k 时出过整轮空回复）**或 ≥100 轮**时，在 pre-step 注入 `<switch-session turns=… context-per-request=…>`——一句给模型的指令（"请提醒用户新开会话，先把进度写进 state.md 接手须知"），因为插件没有用户可见的消息通道。**每跨一级只说一次**（600k/200 轮是第 2 级），翻倍才再说；每轮都说会变墙纸。日志 `switch-session: remind turn=N`、trace `{"event":"switch_session"}`。插件 104 测试（+6：不喊 / 一级一次 / 翻倍再喊 / 轮数轴 / 上限 / 渲染）。口径与阈值记在插件仓库 `dsh-plugin-soulbridge/docs/cost-visibility.md`。

**09:35 每轮成本可观测（quality.mjs）**：`turn-cost` 事件（插件 0.0.113 起每轮一条）现在被质量报告读进去：每轮请求数（共/合计/平均/p50/p90/最重）、请求数分布（1-5 / 6-15 / 16-30 / 31+）、**每请求上下文 token**（input+cacheHit+cacheWrite；纯输入单独给）、最重三轮（session 前缀 + 轮号）。未完成轮次（`open`，被驱逐/中断）不计入分布、单独计数——半轮不是数据点。七日内实测：39 轮 / 853 次 / 平均 21.9 / p50 6 / p90 49 / 最重 271（4973730c/turn15）；**每请求上下文 355,311 token，其中纯输入只有 4,516**——98.7% 是重买的历史，这就是"该换会话"的客观信号，现在在仪表盘上了。脚本改动，不发版。

**09:00 抽取的取舍可见（core 0.0.116 / 插件 0.0.117）**：两处违反"取舍要可见/不截断"的欠账修掉。① `extractByRules` 丢弃的无结构句子、`validateDraft` 丢掉的坏条目（实体类型错/空陈述/未知操作/空缺口）都进 `ExtractDraft.skipped`（`what` + `reason`），插件日志多 `draftSkipped=N` 与前 3 条明细、trace 多 `draftSkipped`（前 5 条）——以前"句子没被记住"和"抽取器没看它"在所有日志里长得一模一样。② `toStatement` 去掉 `slice(0, 80)`：陈述就是整句，长度由注入侧按"整行取舍"处理——切半句会把用户没说过的话写进记忆（规则 17）。测试 core 314（+4）/ 插件 98；变异 = 改动前状态（4 红 → 绿）。

**08:30 写入侧收口（core 0.0.115 / 插件 0.0.116）**：读取方 1 上线后暴露"窗口薄是写入侧造成的"（实测上周窗口 87 条里只有 2 条可定位）。两套时间语义收成一个：规则抽取的 `findTime` 改走 `time.ts.findTimeExpression`（与窗口同一词表），删掉 `TIME_WORDS`/`TIME_OFFSET_DAYS` 粗略偏移——"上周"从 now-7d 的假 day 变成 range+周一零点，"2026年10月"标 range 不再冒充 1 号那天；日历日统一为 **UTC 零点**（该表达式所在本地日历日）：`startOfDay/Week/Month/Year`、窗口边界、插件 `isoDay` 三处同一单位（钩子本就 `toISOString`）。真实库 day/range 非日历日 2 → 0，quality.mjs 新增观测行。过程教训：修复脚本用 `date(<epoch秒>)` 被这个 SQLite 当儒略日、把两行写成 2000-01-01，而观测只查"是不是零点"没查"是哪一天"、显示 PASS——**验证值，不只验证不变量的形状**（备份 `soul.db.bak-daymidnight-*`）。brief [0027](briefs/0027-time-axis.md) §十。

**23:50 时间检索接 precision（core 0.0.114 / 插件 0.0.115）**：`time.ts` 的 `resolveRelativeTime` 第一次有了调用方——`findWindow` 把「上周/昨天」解析成半开区间 `[from,to)`，`planRetrieval` 的 time 分支带上 `window`（解析不了「那天/月初」就不带，`reason` 里写明）。查询走新原语 `Soul.factsInWindow`：`valid_from ∈ [from,to)` **且** `precision ∈ {day,range}` **且** active——`WINDOW_PRECISIONS` 在 `config/status.ts` 一处声明。这是 0027 §八 的第一个真读者：以前"上周发生了什么"走相关式兜底，`since/until` 过滤不看精度，会把 unknown 的「记下那天」当成「事情发生那天」。`facts()` 的 `until` 同时改成半开：窗口的结束就是下一个窗口的开始。实测 7 条新测试 + 变异检查（去掉精度过滤必红）。brief [0027](briefs/0027-time-axis.md) §九。

**19:30 成本可见（0026，宿主侧）**：插件每轮写一条 `turn-cost`（`trace.jsonl`：请求/步骤/失败尝试/插件调用/四类 token/耗时/结束原因），≥30 次请求时另在 `plugin.log` 打一行；账单脚本读平台导出 zip，按天给金额、请求、三类 token 与"钱花在命中/未命中/输出"的构成，并用 `price×amount` 重算对账（实测差 0.00%）。
**19:43 归属修正**：这两样都不属于记忆层——`packages/core` 里没有一行价格逻辑，账单只是宿主的运维数据。脚本与说明已搬到插件仓库 `dsh-plugin-soulbridge`（`scripts/billing.mjs` + `docs/cost-visibility.md`）；本仓库只留数字，不实现计量。review 见 [audit/2026-11-04-review-cost.md](audit/2026-11-04-review-cost.md)。
**20:40 0027 时间轴落地（core 0.0.113 / schema v15）**：`at`/`at_text`/`at_end`/`at_precision`/`valid_until` 五个名字退场，换成 `valid_from`/`valid_to`/`valid_from_text`/`valid_from_precision`；两端都由模型判定，`putFact` 不再从一端推另一端。抽取模板的「日期」改成「有效从」，新增 `有效到=`（只有状态结束才写），断言的成立时间 = 说出口那天。迁移实测：874 条事实，247 条"有日期就当天失效"的猜测被清掉（active 带 `valid_to` 的现在 0 条），`valid_from` 全部有值。brief [0027](briefs/0027-time-axis.md)。


**18:40 整条线索抽取接通（core + 插件）**：`Soul.extract` 接受 `turns`（整条线索一次调用），新增 `threadTurns()` / `turnThreadId()`；插件 drain 现在把「某轮的触发」解析成「它所属的线索」，一次抽取整条线索、事实按轮号落 `source_turn_id`，成功后清掉同线索的排队轮次。日志新增 `unit=Nturns threadId=…`。测试 core 302 / 插件 87。

**17:10 主题级抽取（core 侧落地）**：`<source>` 改成编号的 `<turn n>`，事实行支持「轮次=N」→ `sourceTurnNo`，`commitDrafts` 用 `turnIds` 映射真实轮号；自包含闸门只对 holder 生效（角色槽不是主语，全量检查会误杀）。插件队列仍按轮入队，**整条线索的切换还没做**。测试 core 301。

**15:30 主题级抽取定案（0025）**：抽取单位改为整条线索（事实必须自包含，主体用名字、时间用绝对日期）；与 [ADR 0035](adr/0035-stage-input-contract.md) 和 [0016](briefs/0016-extraction-consolidation.md) 的“按轮”表述已在原文加修订说明；退场账本登记 `extract-per-turn`（pending，代码尚未切换）。**这一项只有设计，没有实现。**

**15:10 状态由事件关闭**：同一主题下，“10-24 被裁员”结束“在 A 公司”——`supersedeFact` 的关闭时刻改为后继事实的 `valid_from`（事件时间），而不是记录时间。语义判断（哪两条矛盾）仍由模型给「操作=取代」；代码只按事件时间关闭。测试 core 298。

**15:00 valid_until 语义修正（v14）**：事件的有效期到事件结束——`valid_until = at_end ?? at`；无日期的状态保持开放，被取代时才关闭。于是“当前”= `valid_until IS NULL OR valid_until > now`，历史事件自动落选，不需要额外判断事件/状态。测试 core 298。

**14:50 三条时间轴 + 人物卡**：`facts` 新增 `valid_from` / `valid_until`（v13 回填，取代时写 `valid_until`）；`Soul.personCard(name)` 按名字/别名返回最近事实与未闭合问题，CLI `person <name>`，插件 `<about>` 追加最多两行 `未闭合：…`。测试 core 297 / 插件 86。review 见 [audit/2026-11-04-review-time-person](audit/2026-11-04-review-time-person.md)。

**14:20 缺口收缩**：不再为「无日期」生成缺口（两天产生 223 条 open、0 closed，其中 154 条是「日期不明」）；schema v12 关闭存量并加 `close_reason`；`Soul.sweep()` 每次 pre-step 关闭 14 天未回答的缺口。review 见 [audit/2026-11-04-review-gaps](audit/2026-11-04-review-gaps.md)。

**11:40 review 修复**：`我:` 前缀与 `<source-notes>` 从两处副本收敛到 `config/labels.ts` 单点声明（core 0.0.106 / 插件 0.0.109）；插件 T1 测试 fixture 从旧 `原则候选` 槽改到 role/status；`restart-web.ps1` 增加部署前 review 门：health-check 出现 `✗ [review]` 就拒绝重启。review 记录见 [audit/2026-11-04-review-ab](audit/2026-11-04-review-ab.md)。

**10:20 依据有了读者（A+B）**：注入里给推断事实加「我:」前缀（2 字符），并在块后写一次 `<source-notes>` 说明；core 的 `<memories>` 与插件的 `<about>` 都生效。新增 `soulbridge why <factId>`：打印事实、来源、依据轮次（用户话 + 我上一轮回复前 200 字）、证据 id。真实数据实测：`fc_mw0ajy8u_1` 的依据是 `tp_mw0ad7h0_wlct`（用户「看看还有什么问题」）。测试 core 290 / 插件 86。

**00:05 过夜批次（B–E）**：**B 槽位收敛**：`原则候选` → role=lesson + status=candidate；`来源` → `证据`；未分类教训 → status=candidate。schema v11 打开库时迁移（61 条候选槽、54 条来源槽）。`factsByTurns` 增加 `includeCandidates`：归纳证据只取 active，晋升才看 candidate。**C 行为影响**：规则注入已有（插件 `<rules fired=…>`），情绪指令经 pre-step 的 `<affect>`；新增 `scripts/rule-compliance.mjs`：用「规则触发后 10 分钟内、且纠正文本命中该规则触发词」作为疑似未遵守代理。首轮真实数据：`fc_lg_mem_mvwnil1k_lv9s` 触发 8 次、5 次随后被纠正（63%）；`fc_lg_mem_mvwk3vsm_y15l` 5 次 0%；样本 <5 不判决。代理会误报，报告里已注明。**D 导出契约**：`Soul.portableBundle()` 三层（archive.jsonl 全量含原始轮次 / summary.md 可读 /injection.txt 当前注入）；CLI `soulbridge export --dir <目录>`。真实库实测 3822 条记录、6.9MB。**未做**：⑤实体池清理（10 个术语实体、23 个名字编码 id）——属于数据判断，留给你确认；`依据` 槽仍无消费者（225+ 条），需要先定「推断证据怎么用」再做。

**23:10 角色由模型选（D 步）**：抽取模板增加 `角色=` 键值（observation/judgment/rule/profile/promise/lesson），`parseFactDraft` 与行解析都读它，未知值忽略；写方不再从中文类型名猜角色（`putFact` 只认传入值，默认 observation，未知值抛错）；`markRule`/`markProfile` 显式写 role，`markUnclassified` 改为 status=candidate；`recordConclusion`/`applyProfileMerge` 显式写 judgment/profile。测试 285 全过。

**22:40 状态词表收口（C 步）**：`config/status.ts` 只剩 `raw/candidate/active/retracted`；读方不再接受旧五值（`isActive` 只认 active，`isRetracted` 只认 retracted）。schema v10 在打开库时把存量转过去（none/open/kept → active，broken/superseded → retracted），`supersedeFact` 写 retracted，facts 列默认值改 active，`factsByTurns` 只取 active。线上实测：schema_version 10，status 只剩 **active 573 / retracted 56**（此前残留的 none 40 / superseded 4 已归零），读路径 judgment=81 / rule=65 / profile=12 正常。core 0.0.101、插件 0.0.107 均由 CI 按 tag 自动发布。

**20:05 角色/状态迁移（A+B）**：A 步上线（代码同时认新旧两套值，`roles.ts` 单一裁决）；B 步已跑：备份 `soul.db.bak-roles-*`，role 分布 observation 296 / judgment 79 / rule 65 / profile 60 / lesson 13 / promise 8，status 只剩 active 470 / retracted 51。**发现并补了一个洞：新写入的事实不会带 role**，已在 `putFact`/`setFactTypeName` 里按旧类型名派生，否则新规则/画像会变成 observation。C 步（删回落）待办。

**19:20 词表对字段（第 3 件）**：新增 [vocabulary-map.v1](spec/vocabulary-map.v1.md)。关键发现：`type_name` 同时承担"是什么"和"到哪一步"，所以要拆成 `role`（模型选，闭合集）+ `status`（代码写，三态）；`依据` 槽 225 条**无人读**，`原则候选` 50 条可删，`来源` 54 条与 `证据` 重复。冻结清单三件已完成。
**18:45 提示词外置**：5 个模板从 `prompts.ts` 移到 `packages/core/prompts/*.md`，生成 `prompts.generated.ts`（普通字符串常量）；`build` 先跑 `sync-prompts --check`，`health-check` 新增同源检查。**反引号截断模板这一类错误不再可能。** 渲染输出 4416 字符逐字节一致。

**16:55 取代成为机制**：抽取行支持 `操作=取代 <id>`，闸门只认库里真实存在的同作用域事实；编造 id/无 id 退化为新增并记 `unknown-supersede-target`。**「记忆会更新」从纸面能力变成行为。** 修法选择 A（模型显式指定），B（代码自动判同槽位）留待数据。core 279 测试，0 FAIL。

**15:55 整体 review（补 A9）**：新增 [下午 review](audit/2026-11-03-afternoon-review.md)，发现三件事：值域单一声明当天被自己破了（2/3 处副本）、`supersede()` 没有业务调用者、归纳的真天花板是"每轮一次调用"。checklist 加 A9：**一项做完必须整体看一遍**，不是跑检查。

**15:35 改走自上而下**：新增 [0024 从构想向下重排](briefs/0024-soul-layer-rebuild.md)（五层模型 / 阶段契约 / 留退补 / 重排顺序 / 五个待定问题）；**在此之前不改业务代码**。调度公平已上线（plugin 0.0.101），但发现更硬的天花板：阶段链每轮只给一次模型调用，而每轮开头总有一条 live 抽取——归纳结构性排不上，这属于 0024 §3 的调用预算问题，不再打补丁。

**16:05 规则索引**：新增 [rules.md](rules.md)——把 W/B/U/D/F/T/P/R 八组通用规则收成一页索引（权威 + 机器检查），并修好 7 份文档里 19 处「换行写成反引号+n」的损坏；health-check §4.6.1 改为**全量扫描**（非 UTF-8 / 字面换行 / 行首残片）并升为 FAIL。

**15:10 边界可检查（ADR 0027 补充）**：槽位值只有带 `@` 才是实体引用（语法不再推语义）；实体类型不再有默认值；holder 只能引用已存在实体；`health-check` 新增 9.5 节（值域单一声明 / 无语义默认值 / 库内值域警告）+ 4 条 `boundary` 测试。core 275 测试。

**14:30 整轮输入（ADR 0035 第 1 步）**：抽取输入从"用户的话"改为"整轮（用户 + 我的回复）"；来源按说话人标（用户 told/experienced，我 inferred），inferred 事实自动带 `依据=<本轮 id>`；handoff 写双方；日志新增 `inferred=`。core 271 / 插件 82 测试。

**12:35 主题演进**：线索主题不再停在第一轮——`继续` 行可带 `主题=`，模型给了才更新；新增 `threadLine`（present/absent/invalid）与 `topicUpdated` 观测，兜底率不再靠推断。core 268 测试。

**11:20 观察工具**：
node scripts/attribution-stats.mjs`（`--all` 看历史）输出归属分布与 ADR 0034 四项通过线；**样本 <20 次归属只观察、不判定**。部署后基线（全历史）：159 条线索，136 条单轮，≥2 轮 7%，≥2 事实 4%。

**11:10 修复摘要**：去掉会进模型视野的截断——候选行、上一句、主题、分类输入、交接块、归纳轮次全部整句进入；凭空造主题改用「第一整句」。core 266 / 插件 81 测试。

**10:35 修复摘要**：ADR 0034 第 1 步——候选线索带近轮原文、`previousUserText` 接线、归属失败默认接上一轮（`joinReason` 可审计）。core 265 测试。

**09:30 修复摘要**：抽取队列可观察——单一导出写入器、backlog 与 cap 丢弃日志、`requeue-history.mjs` 重排脚本；实测 20 条入队后逐条 drain（20→11，每条产出 1 事实）。插件 79 测试。

**09:10 修复摘要**：`memories` 写入退役——`observe` 只做 affect，`remember`/`rememberExplicit`/`reflect` 写 facts，`recall`/`list` 读 facts；16 条旧行迁移并标 superseded（保留可审计）。双 prompt、双闸门、双模型调用消失。core 260 测试。

**08:45 修复摘要**：日历校验——不存在的日期不再滚动（`2026-02-31` 被拒而不是变成 `03-03`），精度随之降级；`review-probes` 8 段全绿。core 267 测试。

**08:20 修复摘要**：抽取提示词重写——每个术语一处定义 + 算/不算边界（`<terms>` 1302 字），格式说明与规则不再复述；别名加入实体索引（「阿林」不再被降级为文本）。core 263 测试。

**07:40 修复摘要**：提交闸门从"过滤器"改成"标注器"——未声明槽位降级为文本、未知持有人回落世界层，只有读不懂与完全重复才拒；新增 `droppedSlots`/`holderFallbacks` 计数。core 261 / 插件 77 测试。

**01:25 修复摘要**：空置信字段不再落成 0（`UNKNOWN_CONFIDENCE` 单一常量，文本/JSON 共用）。core 255 测试。

**01:10 修复摘要**：注入块统一转义（core `inject-text.ts` + 插件六个块），内容不能再伪造标签或提前闭合块。core 251 / 插件 77 测试。

**00:50 修复摘要**：数据库迁移与版本号同一个事务，失败回滚；v5 重跑不再重复插 step。core 248 测试。

**00:35 修复摘要**：WAL 备份改为 `VACUUM INTO` + 完整性校验，坏备份挪走并拒绝升级（备份从"有"变成"有效"）。core 247 测试。

**00:20 修复摘要**：实体刷新不再清空别名与属性（别名累积、属性合并），`latestAbout` 刷新后仍能按别名命中。core 246 测试全过。

**00:05 修复摘要**：`distill` 开关退役，`extract` 成为唯一模型开关；无模型时分类/归纳不再入队（避免 cap 丢新项）。distill 退场项翻成 done。

**23:40 修复摘要**：`section` 不再带 `<affect>`（每轮变的值会让 DSH 每轮追加一个 prompt 版本）；core 新增 `includeAffect` 开关，affect 仍走每轮消息通道（core 242 测试 / 插件 70 测试）。

**23:15 修复摘要**：插件侧模型失败不再被当成"模型说没有"——失败即抛错、归纳草稿读不出来退队重试、验证阶段 3 次上限（插件 68 测试全过）。

**22:50 修复摘要**（详见代码审查第六节）：检索路由的三处误判、合并 prompt 示例与闸门不一致、
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
| 1 | 一轮是完整往返 `0010 §4` | `turns` + `steps`；`turn/end` 触发 | **304 轮 / 1650 步** | ✅ |
| 2 | 推理存但不注入 | `recordTurnPair({steps})`；召回只读正文 | reasoning 块入 steps | ✅ |
| 3 | 抽取=模型填表+闸门 `ADR 0029` | `renderExtractionPrompt` + `validateDraft` | **99.3%** 走模型 | ✅ |
| 4 | 不记对话动作 `0016 §4` | prompt 的四类 `<when-to-write>` | 请求类产出 facts=0 | ✅ |
| 5 | 话题是线索（A B A）`0017` | `threads` + `applyThread` | 159 线索；**≥2 轮仅 11 条（7%）**；新策略样本 0 | ⚠️ 待验收（ADR 0034） |
| 6 | 线索按空闲轮闭合 `0017 §4.3` | `closeIdleThreads` | 默认 6 轮 | ✅ |
| 7 | 归纳按线索 `0017 §4.4` | `threadContext` + 两阶段 | 结论支持率 100%（5/5，证据均可追溯） | ✅ |
| 8 | 结论=事实+≥2 证据 `ADR 0031` | `recordConclusion` / `conclusionSlots` | 5 条结论，关闭线索 153 条 | ⚠️ 产出率低 |
| 9 | 系统提示只放稳定内容 | `section` 88 字符 | 无抖动 | ✅ |
| 10 | 动态记忆走消息通道 | 锚点 + `<about>` + `<related>` + `<handoff>` | 注入 1.9–5.4KB | ✅ |
| 11 | 上次聊到哪 = 上一闭合线索 `0017 §4.5` | `lastClosedThread` + `renderHandoff` | **已触发 14 次**（trace `inject` 的 `handoff:true`，最近 19:52） | ✅ 机制 / ⏳ 对不对没判据 |
| 12 | 情绪读出用户状态 | 词典 `analyzeAffect`（模型未接） | **2.4%**（17/699，11-04） | ❌ |
| 13 | 可携带（导出契约）`ADR 0028` | `Soul.portableBundle()` + `soulbridge export --dir` | 3822 条记录 / 6.9MB（11-04 实测） | ✅ |
| 14 | 行为影响（记忆改变行为） | 无（0018 挂起） | — | ⏳ |
| 15 | **三层：规则 / 画像 / 记忆** `ADR 0033` | 规则 62 / 画像 56 / 事实 223 | 三层都在注入 | ✅ |
| 16 | 规则按触发注入（不常驻） | `selectRules` + `<rules fired=…>` | 触发过 **12/62（19%）** | ✅ |
| 17 | 画像按维度注入 `ADR 0021` | `selectProfileFacts`（core + facet） | 9 条，**4/7 维**，可追溯 8/9 | ✅ |
| 18 | 合并按维度切开（今晚） | `groupProfileCandidates` + `mergeableGroups` | 输入 9→1，跨维度输出被拒 | ✅ |
| 19 | 派生 = 引用了来源（今晚） | `isDerivedProfileLine` | 8/9 条派生行不再进合并输入 | ✅ |
| 20 | 分类是队列的唯一活水（今晚） | `markProfile(dimension)` → `enqueueProfileCandidate` | 队列现为 0 条（无新教训） | ✅ 机制 / ⏳ 数据 |
| 21 | T1：纠正才升格（今晚） | `wasCorrectedTurn` + `promotionCandidates` | e2e 通；**信号 precision ~1/3** | ⚠️ |
| 22 | 候选 / 生效 / 撤回 | `facts.status` 只有 
one`/`superseded` | "候选不生效"**无处表达** | ❌ |
| 23 | 老 `memories` 退场 | **写入路径已删**；16 条迁移成 facts 并标 superseded | active 0 / superseded 16 | ✅ done |
| 24 | 冻结层清理 | `turn_pairs` **97 行、0 写者** | 无写入、只有迁移在读 | ⚠️ |

## 三·零、2026-11-03 12:50 现状快照

```
轮次 304 · 步骤 1650
事实 223（世界层 11 / 有日期 4 / 结论 5 / 被取代 47）
实体 22 · 缺口 11 · 情绪样本 590
线索 159（closed 153 / open 6；1 轮 136 条，≥2 轮 11 条）
老 memories：active 0，16 条已迁移成事实并标 superseded
队列：抽取 0 · 分类 0 · 画像 1 · 归纳 0
```

## 三·零之二、2026-11-04 20:00 现状快照（今天所有改动之后）

```
轮次 407 · 事实 819（active 702 / candidate 61 / retracted 56）
角色：observation 466 · judgment 112 · rule 84 · lesson 81 · profile 57 · promise 19
结论 21 · 线索 207（closed 205 / open 2）· 缺口 86 开
实体 96：thing 90 · person 4 · place 1 · self 1
带来源轮 625/819（76%）· 有 valid_until 270
情绪样本 699，非零 17（2.4%）
注入：408 次，平均 7.9 条 id/轮，其中 handoff 14 次
`soul_recall` 被模型调用次数：0
```

**这张表读出来的三件事**：① 数量级够（2 条事实/轮），可追溯 76%；② 世界层仍薄（person 4、place 1）；③ **模型从不主动 `recall`**——检索这条能力目前只在注入侧被用到，主动查询是零。

管线（一条）：`turn → 抽取队列 → extract（唯一 prompt）→ commitDrafts（标注器）→ facts → 归纳按线索 → 结论 → 画像按维度合并`

正在验收的实验（ADR 0034）：归属默认继续。部署 0.0.98 之后尚无抽取样本，

node scripts/attribution-stats.mjs` 会在归属 ≥20 次时给第一个判决。
现象记录：今早那批历史回填让世界层从 1 涨到 11、有日期从 0 涨到 4——事实开始带时间了。
## 三·一、下次从这里继续（未完成，别重开）

换话题/换会话前先读这一节，**它比记忆可靠**。

```
正在验收：ADR 0034 归属实验（默认继续）
  命令：node scripts/attribution-stats.mjs
  样本：部署后归属次数 < 20，暂无判决
  通过线：归属率 ≥90% · ≥2 轮线索 >50% · 每 10 关闭 ≥5 结论 · 证据可追溯 100%

待实现的设计（ADR 0035，已写成契约，未动代码）：
  抽取输入改整轮（用户 + 我的回复）、handoff 写双方、来源按谁说的标
  验收：我的承诺能被抽成 fact（holder=self、source=inferred、带依据）

判决之后的分支（不要提前做）：
  过了 → 查归纳产出率为什么低（153 关闭线索只有 5 条结论）
  没过 → 改归属（提示词 / 候选近轮 / 解析），不碰归纳

不要做的事：
  · 判据没过就补 210 条历史——会用旧归属再造一批单轮线索
  · 判据没过就动归纳参数——会把归属的问题记在归纳账上

部署契约（每次发版照做）：
  build → verify-installed → 覆盖副本 → 重启 → manifest 改到对应 tag
```
## 四、四个比率（
node scripts/quality.mjs --days 7`）

| 指标 | 值 | 通过线 | 判定 |
|---|---|---|---|
| 事实密度 | **0.73 条/轮**（223 / 304） | ≤1.5 | PASS |
| 抽取走模型 | **99.3%**（147/148） | ≥80% | PASS |
| 结论支持率 | **100%**（5/5） | ≥80% | PASS（样本仍小） |
| 情绪非零率 | **2.4%**（13/590，词典地板） | ≥50% | **FAIL**（模型情绪未接） |

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

账单独在宿主仓库（成本不是记忆层的事）：

```powershell
cd D:\git-workspace\repos\dsh-plugin-soulbridge
node scripts/billing.mjs --days 4    # 每天花了多少：金额/请求/三类 token（读平台导出）
```

## 八之二、环境与工具

| 东西 | 在哪 |
|---|---|
| 重启 DSH | `dsh-plugin-soulbridge/scripts/restart-dsh.ps1`（必须由计划任务 `DshRestartOnce` 拉起，120s 延迟） |
| 重启日志 | `~/.soulbridge/restart.log` |
| 插件日志 / 轨迹 | `~/.soulbridge/plugin.log`、`trace.jsonl` |
| 真实数据 | `~/.soulbridge/soul.db` |
| 线索验收 | `scripts/abba-check.mjs --topic <词>` |
| 队列文件 | `pending-extract / pending-classify / pending-profile / pending-threads.json`；段状态 `segment-state.json`（压缩标记 + seal ≤100，超限有日志） |

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
4. 发版前 
npm test` fail 0，且 `verify-installed.mjs` 通过
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
