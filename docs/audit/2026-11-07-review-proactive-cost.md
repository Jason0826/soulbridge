# 整体 review：0028⑤ 抽取单元必填 + 0018①② 主动建议（注册表 → 成本 → 压缩预算）

- 日期：2026-11-07
- 批次：插件 `f9953dd`（0028 5）· `c2663e7`（0018 1）· `f72b010`（0018 2，v0.0.123）；core **0 个待审**（`9e4e886` 起只动 `scripts/` 与 `docs/`，不进 A9 路径）
- 关联：[state.md](../state.md) 02:10 条目 · [0018 §九](../briefs/0018-behaviour-influence.md) · 插件仓 `docs/cost-visibility.md` 主动建议节 · [11-06 审查](2026-11-06-review-attribution-replay.md)
- 判定：**通过（三条发现见 §四；生产证据 10:15 补至「五过一等」：成本文案 08:30 ✅、ledger-compact 10:10 ✅、outcome 2/2 采纳 ✅，余 compact-limit 一条见 §三）**

## 一、加了什么、退了什么

| 加 | 同批退掉的 |
|---|---|
| `f9953dd`：`runExtraction(..., unit)` **unit 必填**——抽取单位恒为离开点冲刷的段（drain 唯一调用恒传 `{turns}`，结构上不可能再走单轮） | 单消息 fallback `[text]`、三处 `unit?.` 可选链、`1turn` 日志分支——`retirements extract-per-turn` 的宿主侧（规则 5：旧表示同批退场） |
| `c2663e7`：`PROACTIVE_TRIGGERS` 声明式行（`context-compact` 200k / `switch-session` 300k·100 轮），`due()` 返回 `{id, action, block, trigger}`，trace 事件 `proactive` | trace 事件 `switch_session`（全仓 grep **0 残留**） |
| `f72b010`：`compact-limit` 行（已压 ≥2 次 且 ≥200k → 这次建议换新会话）；render 带**每轮 ¥**（离峰价：n×命中 0.02 + 驱逐 0.29×未命中 1，基线 27k 实测）；`sessionLedger.compact()`——`compaction/end` 重置上下文弧 + 重武装 200k 闸门 + 计 compactions；`recentRequests` 滚动窗（任务风格，跨压缩存活） | turn 14「每请求 350k」虚报 13 倍的根因（弧不感知压缩） |

EOQ 推导（`C* = R + √(2Fg/k)`，参数全部来自本会话 trace；叙事定价 ¥0.2/次 → 196k ≈ 现行 200k；平台 100k–210k ±20%、硬边界 80k/300k）写进 `cost-visibility.md`——200k 从魔数变成有推导的数。

## 二、检查结果（都是跑出来的）

```
测试     插件 128 全过（0018 批 +4：压缩后重武装 / 预算流 / partition 契约 / 成本文案）
变异     本批三个新检查各验红：去重置闸门 → 恰 2 红；去让位闸门 → 恰 2 红；
         禁 compact-limit → 恰 2 红（0018① 批内：去 compact 行 4 红、去 once-per-level 4 红）
单点     runExtraction 调用面 grep = 1 处恒传 {turns} → unit 必填的结构保证（规则 10：失败会抛）；
         firstSentence 自带 `?? ''` 兜底 → userText 缺失退化为空话题不崩（规则 11 可区分）
旧事件   switch_session 全仓 grep = 0 残留
棘轮     插件 3127 → 3241（+114），budget history 38 条；
         health-check 0 FAIL / 18 WARN / 25 PASS
发布     v0.0.123 → tag → npm 01:43:45 → corepack pnpm add → verify-installed 6 PASS
         （显式传 web 路径——默认打 desktop 的旧拷贝会 DbNewerThanBinaryError，见 §四 3）→
         DshWebRestartOnce → apply() called (v0.0.123) @ 01:51:47 实测
重启     宿主重启杀掉实施轮（turn 18 未入 turns 表）——0028 §十「重启杀轮」缺口第二次实证
```

## 三、生产证据状态（规则 20：空样本不写「已通过」）

| 行为 | 证据 | 状态 |
|---|---|---|
| `context-compact` 触发（0018①） | 11-06 13:52:44Z turn 13 `proactive id=context-compact trigger=342350` → 注入 | ✅ 已验收 |
| `switch-session` 触发（0018①） | 11-06 14:44:11Z turn 14 `proactive id=switch-session trigger=350356` | ✅ 已验收 |
| 段单元抽取（0028⑤） | 11-06 14:46:44Z `segment-seal trigger=compaction turns=10 outcome=ok`（0.0.122 运行） | ✅ 已验收 |
| `ledger-compact` 事件（0018②） | 11-07 **02:10:39.945Z**（北京 10:10:39）`compaction/end`（sourceCommandId 手动 /compact；02:14:37.732Z 段冲刷 turns=6 chars=13844、extract-queue drained 6 ok）→ **31ms 后** `02:10:39.976Z ledger: compaction observed, context arc reset (compactions=1)` + trace `ledger-compact` 02:10:39.977Z（log+trace 双证据，v0.0.123 生产首走；§四 1 未咬合——本弧 stats 已存在，计数正确=1） | ✅ 已验收 |
| `compact-limit` 行 | 需同会话第 2 次压缩、再过 200k 线（10:10 已压第 1 次 → compactions=1/2；还差一整弧：新弧过 200k → 再压 → 再过 200k） | ⏳ 待验收 |
| 成本文案（每轮 ¥ / 13 倍） | 11-07 **00:30:49.922Z**（北京 08:30:49）turn 20 `proactive id=context-compact trigger=347805`（log+trace 双证据）→ 注入块含「每轮约 **¥0.21** → 压缩后 **¥0.02**（差 **13** 倍）」+ 离峰价标注 + 长离开建议；数字与 turn 19 实测（15 请求 × 348k，k=0.59）对账一致 | ✅ **已验收** |

剩一条等自然时间：`compact-limit`——**11-07 18:05 已压第 2 次（compactions=2，预算花光）**，下一条弧过 200k 即触发换会话建议（0.0.125 起账本重启时从 trace 重建，预算数不因重启丢失）。**outcome（0018 §九 2）两格已齐、2/2 采纳**：格 1 = 11-06 13:52:44Z 建议 → 14:20:57Z 压缩（28 分钟）；格 2 = 11-07 00:30:49Z ¥ 文案建议 → 02:10:39Z 压缩（1 小时 40 分钟）——配对报表（§九 2）数据已够起步。隔夜驱逐预测同批兑现：turn 20 turn-cost `input`（未命中）= **391,122** ≈ ¥0.39（08:30 预估 ~¥0.35），该轮 = 命中 2,229,952×0.02 + 未命中 + 输出 11,925×4 ≈ **¥0.48、驱逐占 81%**——「长离开前先压」文案的生产实证。

## 四、发现了什么（没在这次修的）

1. **`compact()` 对未见过的会话返回 0** → **已关闭（0.0.125，ca94368，2026-11-07 18:55）**：修法按原建议落地——无 stats 时建壳；同批 `apply()` 启动时从 trace.jsonl 重放账本（turn-cost→note、ledger-compact→compact 按绝对数对账），重启不再清空预算/弧/轮数。ghost compact 与预算重放各有测试压着（变异 1 红 / 2 红）。
2. **离峰价写死在 render**：高峰时段（工作日 9–12 / 14–18 全价 2×）真实成本是文案的两倍——文案已标「离峰价」所以不撒谎，但高峰时低估。v2 低打扰窗口可顺带带时段（时段信号与打扰窗口同源）。
3. **`verify-installed.mjs` 默认打 desktop profile**：其 soulbridge 是 v9 时代旧拷贝 → 对 v15 库 `DbNewerThanBinaryError`。本次显式传 web 路径绕过；desktop profile 长期未更新本身是待办（非本批引入，默认值是历史遗留）。

## 五、结论

三个提交把主动建议从「一个阈值一句提醒」补成「有价签的决策器」：`f9953dd` 让抽取单位变成结构必填（单调用面压着），`c2663e7` 把习惯落成注册表行（0018 §0 通用性验收线有测试），`f72b010` 把 EOQ 算出的边界写进文案、让账本感知压缩（修 13 倍虚报）。128 测试全过、变异三红三绿、发布链走完 `apply()` 实测。0018① 与 0028⑤ 的行为已有生产样本；0018② 三条新行为里 ledger-compact 与成本文案已由 11-07 自然样本闭环（规则 20：不提前写「通过」），剩 compact-limit 一条等第 2 次压缩后的自然触发。
