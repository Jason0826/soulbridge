# 整体 review：0018 §九 3 第二刀 A（教训 → 候选 → 分类 → 行为）+ verify-installed 快照修复

- 日期：2026-11-07
- 批次：core `9fc9806`（教训一律候选 + 分类置 active + schema v16，v0.0.118）· core `07fb0eb`（verify-installed 只开快照）· 插件 `701e335`（全部教训入队分桶 + 纠正补查 + 存量入队，v0.0.127）
- 关联：[state.md](../state.md) 23:20 条目 · [0018 §九 3](../briefs/0018-behaviour-influence.md) · [0023 候选门修订注](../briefs/0023-when-a-lesson-is-promoted.md) · [ADR 0033 修订注](../adr/0033-rules-profile-memory.md) · [上一批 review](2026-11-07-review-proactive-cost.md)
- 判定：**通过——但有前置条件（F1）**。三个提交把「教训」从「写入即旁路生效」改成「候选 → 分类 → 规则/画像/待修」，并把存量 98 条一次性收进队列，生产上 5 分钟跑完（70 规则 / 19 画像 / 9 待修）。**但本批产出在提交版里几乎读不到**：`rules()` 按「最新 500 条事实」扫描，分类后的 131 条带触发规则里 **只有 2 条在窗内**，因此「教训→行为」的验收样本不可能出现。审查期间作者已在工作区改了 `rules()`/`profileItems()`（未提交，326/326 绿），但**注入路径 `profile()` 仍扫 500（47 条画像里 14 条在窗外）**。F1 的读取面修复存在未提交改动，且 `profile()` 未被覆盖——见 §四 1。
- 口径：本 review 只针对上述三个**已提交**版本；审查期间工作区正在做 0.0.119 的收尾（`package.json`、`state.md`、`budget.json` 与 F1 修复均未提交），未计入判定，但在 §四 1/10 里点名。

## 一、加了什么、退了什么

| 加 | 同批退掉的 |
|---|---|
| `writeStatus(role)`：`role=lesson` 一律写 `candidate`（commitDrafts 与 recordFact 两条写入路径同一个口径；`undefined` 让列默认继续做 "active" 的唯一声明） | 写入旁路：`角色=lesson` 曾落 `active`，被当 `<memories>` 资料注入且永不进分类（`原则候选=是` 是唯一入口） |
| `activatePlaced()`：分类（`markRule`/`markProfile`）把候选置 `active`；retracted 行不复活 | 分类只改 role/type 不改 status → `rules()` 读不到 → **分类成功的规则永不触发**（本批发现的第二个洞） |
| schema **v16**：`role='lesson' AND status='active'` → `candidate`（幂等；已分类的行角色是 rule/profile，不动） | 37 条旁路存量教训的 active 态（一次性追平，备份 `soul.db.bak-v15`） |
| `FactQuery.role` 过滤 + `Soul.promotionBacklog()`（role/status 直查，oldest first，上限 400） | 只能逐轮喂（旧生产者在抽取成功轮里，历史轮永远不再经过） |
| 插件：`feedClassifyFromTurn` 去「仅纠正轮」门，全部教训入队；桶 `T1-修正`/`全收`/`存量`；`peekClassifyBatch` 按桶排序（桶内到达序，稳定）；`reBucketQueuedCandidate` 原地改桶不重投 | 0023 T1 作为**门**（「纠正轮以外一律不进」）→ T1 降为**桶**（批序第一）；trace `promote` 的 `rule:'T1'` → `bucket` |
| 插件：`backfillClassifyFromCorrection`（纠正晚到：按纠正自带的两条链接找轮次，改桶/重投）；`backfillClassifyBacklog`（存量一次性入队，走队列自己的写者 + marker） | ——（新增补漏路径，未退旧路径） |
| `verify-installed` 改为 `VACUUM INTO` 快照后再 `openSqlite`；runbook 记「装完立刻重启」的裸窗口 | 用真实库加载产物 → 验证顺手把生产库迁移掉（见 §四 9） |

## 二、检查结果（跑出来的）

```
测试     core 324/324（提交记录；本次实跑得同一数字，随后工作区出现未提交修复时再跑 326/326）；
         插件 141/141（+4，实跑）。两次 core 实跑之间作者在工作区加了 rules/profile 读取面修复，
         所以「324」既是提交记录也是审查开始时的实跑结果，两者没有被混用
类型     npx tsc --noEmit：0 错
单写者   分类队列只有 readClassifyQueue/writeClassifyQueue 一对（cap 400，丢弃有日志）；
         存量走 enqueueClassifyCandidate（同一个写者），未新增脚本直写 → seed-backfill-write 债未扩大；
         runClassifyStep 的 retry（3 次上限）/ abandon 逻辑未动
上限     findTurns(limit 10) → 实测 12 条同文轮次只链 10 条；promotionBacklog slice(400)；
         facts(limit 1000) 与 rules 的 2000 是静默上限（见 §四 7）
可观测   trace：promote(bucket)、classify-backlog、classify-backfill、classify(reasons)；log 逐批一行
唯一表示 桶标签集中在 CLASSIFY_BUCKETS（一处声明，rank 派生）；「lesson → candidate」只有 writeStatus 一处
         （v11/v16 是迁移，不是声明）；但提取侧仍是两个输入信号（见 §四 8）
部署     R1/R3：core tag v0.0.118 / 插件 tag v0.0.127 / package.json / profile manifest 四处一致；
         插件锁 soulbridge 0.0.118（发布版）后复跑 141/141（T4：验产物）；apply() called (v0.0.127) @ 15:08:25Z
回滚     v16 前的备份在位：soul.db.bak-v15（23:00:59，16,093,184 B）
变异     未复跑（需改源码，超出「只写文档」范围）；按提交记录采信，见 §四 10 的说明
编码     health-check §4.6.1 全量扫描 PASS（123 份文档，不只扫本批 diff）
```

## 三、生产证据（规则 20：空样本不写「已通过」）

```
15:10:01Z  classify backfill: 98 backlog lesson(s) queued (存量)      ← 存量全收，marker 随后写
15:10:17Z–15:15:43Z  classify: batch=10 ×9 + batch=8 ×1（reasons=存量）
           合计 98 条 → rules=70 · profiles=19 · pending=9
之后       pending-classify.json = []（队列清空）；lesson/candidate 从 98 → 9（新会话新增）
           分类把 70 条变成规则（条条带触发）、19 条变画像：rule/active 113 → 187（带触发 61 → 133）、
           profile/active 41 → 47、profile/retracted 46 → 63（合并/取代的源行）
           （以上为 23:20–23:24 读数，系统仍在动；窗内外比例不受影响，见 §四 1）
           trace：classify=10、classify-backlog=1、classify-backfill=1、promote=4
           rule_fired：**今日 0**（最后一条在 11-03 15:19Z）→ 触发→注入→遵守 无样本，待验收
```

分类产出本身有生产样本（70 条规则、19 条画像、9 条待修都是真实分类结果），但**「上次纠正过的事，下次它自己做到了」没有样本**：`rule_fired` 早已停摆，原因是 §四 1（读路径看不见新规则），不是规则没生成。

## 四、发现了什么

1. **F1 高（缺陷先于本批，但阻断本批验收）：`rules()` / `profileItems()` / `profile()` 用「最新 500 条事实」当读取面。**
   代码位置：`packages/core/src/index.ts` 的 `rules()`（`facts({limit:500})` + 过滤）、`profileItems()`、`profile()`。实测（只读库，23:20–23:24）：
   ```
   facts 1225 条；第 500 新的是 2026-11-04
   active 规则带触发 131→133 条 → 窗内只有 2 条（129→131 条在窗外）
   active 画像 47 条 → 窗内 33 条（14 条在窗外）
   复现（发布版 0.0.118，临时库）：1 条 11-01 的规则 + 600 条 11-07 的新事实 → rules() = []
   ```
   这与本批直接相关：A 把**最老的**教训分类成规则，而 `valid_from` 沿用老教训的时间，于是新规则几乎全落在窗外。线上 `rule_fired` 最后一条停在 11-03 15:19Z，正与库越过 500 条的时间吻合。**审查期间作者已在工作区修**（`rules()`/`profileItems()` 改 role+status 直查、上限 2000，+2 条测试，326/326 绿，未提交），但 **`profile()`（插件注入用的 `soul.profile(30)` 就是它）仍扫 500**，画像注入同样瞎掉 14 条。**建议：把 `profile()` 一并改——它和 `profileItems()` 是同一个判断的两处实现，一处修了、一处没修，正是「同一判断两处实现」的代价（AGENTS 5/6）；改完随本批提交，再验收。**
2. **低：`activatePlaced` 对 missing/retracted 静默跳过，而 `runClassifyStep` 仍按模型自报计数并移除队列项**（`index.js` markRule 分支 `rules += 1`）。复核：临时库 `markRule('fc_does_not_exist')` → 不抛、不建行；该批日志仍会说 `rules=+1`。规则 42「写入没生效要报」：队列项过期时无人知道它被丢了。
3. **低：`markRule` 对已 retracted 的行仍会改 role/type/加槽**（只是不把状态改回 active）。复核：`lesson/retracted` + `markRule` → `rule/retracted`，`rules()` 不返回（不复活），但审计行的角色被改写。建议 `activatePlaced` 的判断提前到改写之前，整条拒绝。
4. **低：`markProfile` 无维度也激活**，而插件 `selectProfileFacts` 对「无维度」一律常驻注入 → 未标注画像行从「不可见」变「每轮可见」。线上 active 画像里 8 条无维度（历史行），本批新增 27 条都带维度（工作方式/沟通偏好），所以今天未触发；但分类器给非法维度时（`parseRuleClassifications` 会把非法维度判成未标注）就会走到这条路。
5. **低：纠正与轮次的链接不唯一，属 fail-open。** 复核：三条用户原话与回复都相同的轮次 → `turns=3, queued=3`；12 条同文 → 只链 10 条（`findTurns` 上限）。方向是「多提几个桶序」而不是「删数据/改状态」，可接受；但意味着 T1 桶不能当「这条就是被纠正的那条」的证据用。
6. **低：存量入队是逐条同步 IO，且每次写 ≥10 条都会打一行 `queue backlog`。** 实测 98 条：15:09:59.815Z → 15:10:01.252Z（≈1.4 s，98 次读 + 89 次写，阻塞在 user/message 事件里）；生产日志里 `queue backlog (pending-classify.json)` 共 95 行。`writeQueueFile` 的这条日志非本批引入（`pending-threads` 已 401 行），但本批把它从「偶尔」放大成「首次装机 95 行」。可接受（一次性），若要收，改成一次批量写 + 一条汇总日志即可。
7. **低：静默上限两处。** `promotionBacklog` 的 `facts({limit:1000})` 超过 1000 条候选会被截断且无 `truncated` 标记；工作区把 `rules()` 上限提到 2000，同理。今天百来条远未到线，记债不修。
8. **低：同一条决定仍有两个输入表示。** 提取提示词同时教 `原则候选=是` 与 `角色=lesson`；本批让两者**效果**一致（都落候选），但没规定谁是权威。建议在 0018/0023 写明「角色优先，flag 仅作回退」，否则以后改一个会漂（U1）。
9. **过程（已修）：`verify-installed` 曾用真实库加载产物 → 23:00:59 把生产库升到 v16，而宿主还跑 0.0.117（库比进程新）。** `07fb0eb` 改为 `VACUUM INTO` 快照后验（复核：快照路径跑出 6 PASS，真实库 mtime 不再变化），runbook 记「装完立刻重启」。备份 `soul.db.bak-v15` 在位（R2）。
10. **过程（未进提交）：一次用 PowerShell 往返改 `index.ts` 造成编码损坏，随后整文件回滚重做。** 属 AGENTS 23/T1 的现场违规，最终提交内容干净（§四 9 的扫描 PASS）；因为没进提交，只作纪律记录。本批的变异结论（三组/五组各红）**未复跑**——复跑要改源码；新测试的敏感性由 F1 的实测反证：提交态 324 条测试全绿却没有一条能发现「老教训分类出的规则读不到」，这正是本批测试面的缺口（工作区补的两条就是补这个）。
11. **复核确认没问题（逐项跑过）**：v16 连跑 3 次结果一致、`rule/active` 与 `profile/active` 不动、`profile/candidate` 不动（幂等 + 「分类过的行不动」成立）；`writeStatus` 两条写入路径一致，第三条不存在（reflect.ts 不写 role、插件只走 soul API、v11 迁移本身就写 candidate）；桶序 `T1-修正 → 全收 → 存量 → 未知`，未知 reason 落最后、两次调用顺序一致（稳定）；`enqueueClassifyCandidate` 按 id 去重、`reBucket` 原地改不重投、marker 二次调用返回 0；插件依赖下限 `>=0.0.118` 与 `promotionBacklog` 的运行时硬依赖一致（旧核心下会被 try/catch 兜成一条日志、不崩）。

## 五、结论

三个提交本身是干净的：写入面收口（一条 `writeStatus`）、分类面补上「确认即生效」、队列面从「一个窄门」改成「全收 + 分桶 + 两次补漏」，并且存量在真实库里 5 分钟消化完（98 → 70/19/9），部署链、备份、文档同步都在。

但**判定通过带条件**：A 的验收语言是「上次纠正过的事，下次它自己做到了」，而提交态的读路径只看得见 2/131 条规则——分类产出在线上等于没发生。审查期间作者已把 `rules()`/`profileItems()` 改好（未提交、326/326），**还缺 `profile()`**。把这三处读取面连同两条测试一起入仓、再等一次 `rule_fired`，这条刀才算闭环；在那之前，`rule_fired` 的空样本不是「行为还没发生」，而是「读数坏了」。

**补记（2026-11-07 23:35，F1 已修）**：`eadfa40` / core 0.0.119 把三处读取面一起改成 role+status 直查（`profile()` 也改了），326/326 绿，三条查询各自的变异恰 1 红，上限 2000 的理由写进 docstring 与 budget history。F2–F8 作为低债记下，未在本次修（F8 的「角色优先、flag 只作回退」已写进 0018 §七 修订注）。
