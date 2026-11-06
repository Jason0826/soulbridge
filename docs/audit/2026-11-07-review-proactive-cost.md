# 整体 review：0028⑤ 抽取单元必填 + 0018①② 主动建议（注册表 → 成本 → 压缩预算）

- 日期：2026-11-07
- 批次：插件 `f9953dd`（0028 5）· `c2663e7`（0018 1）· `f72b010`（0018 2，v0.0.123）；core **0 个待审**（`9e4e886` 起只动 `scripts/` 与 `docs/`，不进 A9 路径）
- 关联：[state.md](../state.md) 02:10 条目 · [0018 §九](../briefs/0018-behaviour-influence.md) · 插件仓 `docs/cost-visibility.md` 主动建议节 · [11-06 审查](2026-11-06-review-attribution-replay.md)
- 判定：**通过（三条发现见 §四；三条新行为的生产证据按规则 20 记「待验收」，见 §三）**

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
| `ledger-compact` 事件（0018②） | 需 v0.0.123 上线（01:51:47 ✓）**之后**的下一次真实 compaction | ⏳ 待验收 |
| `compact-limit` 行 | 需同会话第 2 次压缩、再过 200k 线 | ⏳ 待验收 |
| 成本文案（每轮 ¥ / 13 倍） | 需 `context-compact` 再次触发（重启后账本从空起步，本会话压缩后弧未过 200k） | ⏳ 待验收 |

三条各等一个自然样本：下次压缩看 `ledger: compaction observed` + trace `ledger-compact`；第二次压缩后再过线看 `proactive id=compact-limit`；下次过 200k 看文案里的 ¥ 数字。

## 四、发现了什么（没在这次修的）

1. **`compact()` 对未见过的会话返回 0**：`compaction/end` 若发生在本进程首次 `turn/end` 之前（重启后立刻压缩），预算计数少 1。方向是 fail-open（多允许一次压缩，贴用户偏好）但计数不严；修法 = 无 stats 时建 `compactions: 1` 的壳。归下批。
2. **离峰价写死在 render**：高峰时段（工作日 9–12 / 14–18 全价 2×）真实成本是文案的两倍——文案已标「离峰价」所以不撒谎，但高峰时低估。v2 低打扰窗口可顺带带时段（时段信号与打扰窗口同源）。
3. **`verify-installed.mjs` 默认打 desktop profile**：其 soulbridge 是 v9 时代旧拷贝 → 对 v15 库 `DbNewerThanBinaryError`。本次显式传 web 路径绕过；desktop profile 长期未更新本身是待办（非本批引入，默认值是历史遗留）。

## 五、结论

三个提交把主动建议从「一个阈值一句提醒」补成「有价签的决策器」：`f9953dd` 让抽取单位变成结构必填（单调用面压着），`c2663e7` 把习惯落成注册表行（0018 §0 通用性验收线有测试），`f72b010` 把 EOQ 算出的边界写进文案、让账本感知压缩（修 13 倍虚报）。128 测试全过、变异三红三绿、发布链走完 `apply()` 实测。0018① 与 0028⑤ 的行为已有生产样本；0018② 的三条新行为按规则 20 诚实记「待验收」，各等一个自然触发补日志即可闭环。
