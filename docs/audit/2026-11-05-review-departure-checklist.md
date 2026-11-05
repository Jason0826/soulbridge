# 整体 review：0028 实施② 离开点触发检查表 + 段 sealing

- 日期：2026-11-05
- 批次：插件 `1a5a64f`（0.0.120 功能本体）· `9d8c25d`（版本）
- 关联：[state.md](../state.md) 22:35 条目 · [0028 §九](../briefs/0028-departure-flush.md) ② · [budget history](../../scripts/budget.json)
- 判定：**通过（四条发现见 §四）**。0028 §七 四条声明逐条有测试或变异对应；一个隐含前提（pre-step 的 `payload.agent.id` 与事件的 `session.id` 是否同键）用生产数据实证而非假设；旧的按线索解析 drain 路径与 `pickExtractionItem` 同批退场——一个表示换一个表示，不是加第二套触发。

## 一、加了什么、退了什么

| 加 | 同批退掉的 |
|---|---|
| `planSegment` 纯函数检查表：压缩标记 / 会话切换·归档 / 容量（≥40 轮或 ≥6 万字）/ 年龄（>24h）。前两个是语义离开，后两个只当工程兜底——quiet-time 结论（时间信号只配当兜底）写进了注释与代码结构 | 按线索解析的旧 drain 路径（`turnThreadId`→`threadTurns`，读在归属写入之前——state.md 18:05 的时序倒置根因本体） |
| `segment-state.json`：`compaction/end` 无 error 才置标记（error = 窗口没变，留标记会把还在上下文里的内容写成持久记忆）；seal ≤100 条可查、超限有日志；文件损坏挪走、不改判为空 | `pickExtractionItem`（live-first）——它防的饥饿被段语义化解：20 条回填等的是一次调用，不是二十步 |
| drain 无触发只留 `segment-wait` 观测（按缓冲变化去重，不是每 step 一条）；入队日志改 `extract buffered`（"入队=要抽"的旧措辞教错了行为） | `extract queued` 措辞 |
| 段失败 = 整段一起 bump（一次调用覆盖它们），第 3 次封存丢弃（`given-up:` 带原因）；`enqueueExtraction` 拒绝已封存轮，`origin=backfill` 是记录在案的重放例外 | —— |

## 二、检查结果（都是跑出来的）

```
测试     插件 107 → 120 全过；core typecheck 干净、test fail 0（runbook 第 0 步闸门）
变异     ① 去掉 compaction 标记调用 → 接线测试恰红 1 条
         ② 绕过 planSegment 无触发分支 → 6 条红（含「无触发不抽」本体）
         ③ 去掉 enqueue 封存拒绝 → seal 测试恰红 1 条
前提实证  switch_session 记录的 key（payload.agent.id 侧）与 turn-cost 记录的 key
         （事件 session.id 侧）在同一个 sessionLedger 里对账——10:06:51 的换会话
         提醒能触发，即证明两键相同；若不同键，due() 永远新建空账本、提醒永不触发。
         两边格式均为 session-<uuid>（trace.jsonl 实测）
棘轮     插件 +236 按 0026/0027 功能先例记 budget history（含同期删除 -70 余行），
         --update-budget 重写 3051 → health-check 0 FAIL / 18 WARN / 25 PASS
发布     runbook 0.6 质量比率（三条 FAIL 原因写进 state.md 22:35 条目）→ v0.0.120
         → Actions release #109 success（22:15:18Z）→ npm view 0.0.120 实测可见
         → pnpm 11（store v11 匹配）装进 web profile → manifest/node_modules 双确认 0.0.120
部署     verify-installed 6 PASS / exit 0（installed: core 0.0.116 / plugin 0.0.120）
         → DshWebRestartOnce 排队（90 秒延迟，脱离 agent job 对象）——apply() 与
         segment 首个真实样本在下一轮验证后补记 state.md
```

## 三、合起来看：会话内还会抽吗

- **会话中 LLM 抽取调用 = 0 by construction**：turn/end 只入缓冲，drain 过不了检查表就只留 `segment-wait`。这是 0028 第一原理（"抽取是为离开上下文之后做的备份"）第一次落到代码闸门上，而不是靠自觉。
- **归属从前提变成产物**：drain 不再读 `turnThreadId` 决定输入（那个字段要等这次抽取结束才写），输入就是离开点切出的连续轮次；模型输出的线索归属照旧走 `applyThread`（core 未动）。
- **单位换了一次而不是加了一个**：`unit=Nturns` 现在是段；提示词轮次 1..n 经 turnIds 映射回真实 `source_turn_id`（与线索单位同一机制）。
- **成本含义**：每轮 21.9 次请求里不再含会话中的抽取调用；段抽取的成本随离开点走（预计压缩/切换各一次），quality.mjs 的「会话中抽取/轮 → 0」行归 ④ 验收。

## 四、发现了什么（没在这次修的）

1. **rules floor 对段只看最后一轮**：core 既有语义（"Rules work on one message; for a thread that is the last turn"），本次未动 core。llm 走模型 99.2%（quality --days 7）、rules 是模型失败时的地板——地板的地板只覆盖末轮，记录在案，若 ④ 重放发现丢事实再回开放问题 1。
2. **`scripts/seed-backfill.mjs` 仍是绕过写入器的第二入口**（直写 pending-extract、上限 400、无 origin 字段）——reset-derived 之后的恢复工具，requeue-history 已走单一写入器。规则 41 的现存违例，归 ⑤ 或单独清理，不在本批扩大战场。
3. **reset-derived 不清 `segment-state.json` 的 seals**：恢复路径目前靠 `origin=backfill` 例外与 seed 直写绕行，封存记录在 reset 后陈旧但无害；建议 ⑤ 登记时一并决定（清、留、或随 reset 联动）。
4. **重试窗口内新入队的段尾项并入同一尝试计数**（attempts 以段头计、整段同 bump）：上限仍由段头第 3 次守住、丢弃带 `turns=N` 日志，最坏比逐项少跑一次——可接受的有界误差，不为它加状态。

## 五、结论

本批把 0028 的第一原理变成了可执行的闸门：**离开点说了算，不是队列非空说了算**。四条声明里三条（1/2/5）由测试与变异直接压住，声明 4（原文全量来自 turns）由 drain 的取数路径保证。核心复杂度没有增加——检查表是一个纯函数，seal 是一个封顶的标记列表——退掉的旧路径比新增的触发还难写。下一步按 §九 走 ③（归属输出扩多条线索）。
