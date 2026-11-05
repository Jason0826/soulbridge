# 整体 review：地板与成本的可见性（四批）+ handoff 消费修复

- 日期：2026-11-05
- 批次：core `5abd67c`（时间语法与日历日归一）· `0913c3f`（丢弃可见 + 整句）· `8663590`（turn-cost 进 quality）；插件 `b71abcb`（0.0.119：handoff 空不消费 + 日志前缀）
- 关联：[state.md](../state.md) 08:30 / 09:00 / 09:35 / 18:05 / 21:20 条目 · [0028 §九](../briefs/0028-departure-flush.md)
- 判定：**通过**。四批同一条主线——**失败与成本从不可见变可见、两套语义归一**；没有新增第二套表示，唯一净增（插件 +24 行）按棘轮先例记账。

## 一、四批各自加了什么、退了什么

| 提交 | 加了什么 | 同批退掉的 |
|---|---|---|
| `5abd67c` 时间语法 | 规则抽取改走 `time.ts.findTimeExpression`（与窗口同一词表）；日历日 = UTC 零点三处归一 | 删 `TIME_WORDS` / `TIME_OFFSET_DAYS`——"上周"从 `now-7d` 假 day 变成 range + 周一零点 |
| `0913c3f` 取舍可见 | `ExtractDraft.skipped` 带 `what/reason`，规则与模型两路丢弃入列；日志/trace 加 `draftSkipped` | 删 `toStatement` 的 `slice(0, 80)`（半句不再进记忆）；删 `validateDraft` 从未被读的 `knownFactIds` |
| `8663590` 成本观测 | `quality.mjs` 读 `turn-cost`：每轮请求分布、p50/p90、每请求上下文 355k | 无退场——纯读侧脚本，不进棘轮 |
| `b71abcb` handoff 消费 | 消费逻辑抽成导出工厂 `createHandoffTaker`（空读/抛错都不消费，会话隔离）+ 3 条契约测试；`extract ok:` → `extract done:` | 内联 `takeHandoff` 的无条件消费写法——变异还原旧放置，恰好那 1 条红 |

## 二、检查结果（都是跑出来的）

```
core 314 / 插件 107（+3 handoff 契约）全过 · tsc 干净
变异     还原 handedOff.add 的旧位置 → 「empty first read does not consume」红 → 恢复绿
发布链   v0.0.119 → CI → npm view 0.0.119 实测已发布（20:53:35Z）
部署     profile 装 0.0.119 → verify-installed 6 PASS / exit 0 → DshWebRestartOnce 21:01
运行     apply() called (v0.0.119) @ 21:01:05；21:15:57 handoff 真实发出（"SeeCode…" summary=yes，
         prestep inject handoff=yes turn=15）——消费契约在真实运行里走通
棘轮     插件 +24 按首条先例（bug 修复 + 可测性重构）记入 budget history，--update-budget 重写 2815
health   0 FAIL（review 项本次提交后归零，复跑见提交）
```

## 三、合起来看：更绕还是更简单

- **少两套语义**：时间词表归一、日历日归一——0027 §十 余债清单相应减两项（TIME_CUE 两份、calendarDate 两份仍未清，见 §四）。
- **多两个计数器**：`draftSkipped`、每轮 `turn-cost`——观测设施按 0026 先例记账，换回"丢弃与成本不再盲"。
- **handoff 消费有了名字和测试边界**：工厂化是把 bug 变成契约的手段；单文件 +24 行是它的价格，已记账（audit 第六节的单文件债没有变好也没有变坏）。
- **日志口径变更**：10:01 重启是分界——之前的 `extract ok:`、之后的 `extract done:`。以后 grep 用新前缀；state.md/本文件里历史行的 `ok` 是当时事实，不改写。

## 四、发现了什么（没在这次修的）

1. **unit=1turn 根因在本批被定位**（46 条日志，state.md 18:05 条目）→ 归 0028 实施②接手法。重启前 19:52–20:41 四条抽取再次全部 `unit=1turn join=continue`（同一线索 `th_mw3dr9z7`，四次单轮抽）——现象稳定复现，不是孤例。
2. **"空读 → 补发"还没有真实样本**：21:15 这次 handoff 是首读即非空。契约测试覆盖了空读分支；真实样本要等 0028 落地后的第一次"上一段还没抽完就开口"的新会话。
3. **余债不变**：PRECISIONS 字面量副本、TIME_CUE 与语法词表两份、`facts(since/until)` 唯一入口、退场技术债 3 项（anchor-container / json-extraction-shape / extract-per-turn——最后这项正是 0028 实施⑤要翻 done 的）。
4. **规则层与 LLM 的近义重复风险**（0028 §十.1 已定防线：段输入明列已有规则事实 + 完全重复闸门）——实施②时要配观测行，否则防线只是纸面。

## 五、结论

四批都没有开第二条管线：时间只有一套词表、丢弃只有一个列表、成本只有宿主在算、handoff 只有一个消费口。系统比改前**少两套语义、多两个计数器、多一个可测的契约**。0028 实施从②（触发检查表 + 段 sealing）继续。
