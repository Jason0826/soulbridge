# 整体 review：0028 实施③ 归属扩多条线索 spans + ④ §八 四行真实重放

- 日期：2026-11-06
- 批次：core `8bb2147`（spans 本体）· `5e5e816`（0.0.117 版本）· 插件 `4c66d8c`（0.0.121）· core `9a8c1a0`（quality.mjs 指标，`scripts/` 不计 A9 预算）
- 关联：[state.md](../state.md) 05:40 条目 · [0028 §八/§九](../briefs/0028-departure-flush.md) · [② 的 review](2026-11-05-review-departure-checklist.md)
- 判定：**通过（四条发现见 §四）**。③ 的两条声明（每轮挂线、段内只开一条新线索）由变异直接压住，两个真 bug 是测试先抓的；④ 的四行验收三行有生产日志实证、一行空样本记「待验收」不记「已通过」；quality 指标本身被变异证明能红——通过线能算出数。

## 一、加了什么、退了什么

| 加 | 同批退掉的 |
|---|---|
| `ExtractDraft.thread` 单条 → `spans?: ThreadSpan[]`：格式 `线索: <起>-<止> 继续 <id>` / `新 \| 主题`（**无范围 = 整段**，单话题行逐字兼容；裸数字 = 单轮；`5-` = 到段尾） | `ExtractDraft.thread` 单条字段 |
| `readThreadSpans` 多行解析，三态观测 present/absent/invalid 保留、坏行仍可查；**开放端收口**——多行时没写止的段停在下一条线索之前（否则 find-first 永远走不到后面的行；设计 bug，测试先抓） | —— |
| `applyThreadSpans` 逐轮复用 `applyThread`（继续-新 / fallback-previous / 无候选兜底链一字不动，ADR 0034）：**段内 new 只开一条**（逐轮开同话题克隆正是 0028 要消灭的碎片化）、**未覆盖轮链到前一轮**、**每一轮都挂线** | 旧实现只挂头轮的归属洞 |
| 双编号显式传递：提示词 1..n 管范围匹配、真实轮号（宿主会跳 10–30）管线索计数，drain 带 `hostTurnNo` 不猜 | 靠单一编号猜轮号 |
| quality.mjs「离开点」区：`extract` 事件与带 `trigger` 的 `extract-queue` 事件配对（同 tick 实测 98/44ms，窗口 +2000ms），**闸门后未配对 = 会话中调用** | ——（新增指标，见 §二） |

GATE_AT = `2026-11-05T14:33:06.000Z`（②闸门 apply 时刻）。闸门前的 506 次抽取列为历史**不计入**——这是记录在案的取舍，写在输出行里（"窗口内另有 506 次全在闸门之前，不计入"），不是悄悄换分母。

## 二、检查结果（都是跑出来的）

```
测试     ③ core 314→321 / 插件 120→122 全过；quality.mjs 走 runbook
变异     ③ 去范围解析 → 恰 1 红；fan-out 只挂头轮 → core 5 红 + 插件集成 1 红
         ④ quality 指标：GATE_AT 提前到 11-01 → 1.39 次/轮 FAIL（506 次 / 364 轮）→ 恢复绿
         （指标能红，才算有通过线；②三组变异仍有效）
真 bug   两个是测试先抓的：首行吞段（开放端收口）、段内 new 逐轮开克隆
棘轮     core +121 / 插件 +32 按 0026/0027 功能先例记 budget history；
         scripts/quality.mjs 不计 A9 与棘轮预算（脚本改动先例）
发布     core v0.0.117 → release #44 → npm 可见 → 插件依赖下限改 >=0.0.117
         （applyThreadSpans 是运行时硬依赖，0.0.116 下 undefined 每次抽取都挂）→
         v0.0.121 → pnpm 11 装 profile → verify-installed 6 PASS →
         DshWebRestartOnce → apply() called (v0.0.121) @ 05:34:51 实测
```

## 三、§八 四行真实重放（逐行）

**行 1 手动 /compact ✅**（时间戳为日志原始 UTC）：

```
23:57:36.659  compaction/start（command/run 手动触发）
23:58:43.381  compaction/end
23:58:43.385  segment marker: trigger=compaction（+4ms；trace segment-marker + compactionId 49e265c7…）
              ← marker 只置位，当场不调模型
00:00:51.512  segment flush: trigger=compaction turns=2 chars=3543 head=8 origin=live
              ← 下一离开点（第 3 轮 prestep）才抽
00:01:47.382  extract done: facts=9 unit=2turns ms=55869 join=continue
00:01:47.427  segment-seal trigger=compaction turns=2 outcome=ok
00:01:47.428  extract-queue drained=2 remaining=0 trigger=compaction（与 extract 同 46ms 配对）
```

链路符合设计的两段式：**离开点写标记 → 下次 drain 才抽取**；抽取是异步的（flush 00:00:51 → inject 00:00:51.767 没有等它 → done 00:01:47），第 3 轮注入拿不到这 9 条、第 4 轮才拿到——正是开放问题 4 认下的 1 轮延迟，`<related>` 兜底。

**行 2 新开 session ✅**（同一条 session 的完整生命周期）：

```
23:08:43.662  segment flush: trigger=session turns=3 chars=10767（旧 session 的离开点）
23:09:32.493  extract done: facts=17 unit=3turns → segment-seal ok → extract-queue trigger=session
23:54:55.788  第 2 轮注入 ids 含 fc_mw45r3vw_e ← 17 条之一，库查 statement =
              「core v0.0.117 与插件 v0.0.121 已发布，插件依赖下限提到 >=0.0.117…」
              与本会话 <memories> 注入逐字同源（离开点抽取 → 落库 → 下轮注入回来，端到端）
23:54:55.412  segment-wait buffered=1（第 1 轮在等离开点：会话中不抽）
23:54:55.788  handoff:false（第 2 轮不重发；第 1 轮 handoff:true——每会话至多一条）
```

**行 3 单 session 跨天 / 容量兜底 ⏳ 待验收**：无自然发生样本（今天没跨天、没到 40 轮/6 万字）。不写「已通过」——它与行 1/2 走同一个 `planSegment` 纯函数检查表，compaction/session 两个触发已生产走通，容量/年龄两个触发有单元测试 + 变异（② 批次：绕过无触发闸门 → 6 红）兜着；等真实触发补日志证据。

**行 4 quality.mjs → 0 ✅**：

```
会话中抽取/轮   0 次/轮   PASS   (闸门后 0 次 / 4 轮，通过线 =0；
                窗口内另有 506 次全在 0028② 闸门 11-05 14:33Z 之前，不计入)
```

行 1 的 compaction 抽取（00:01:47）与行 2 的 session 抽取（23:09:32）都带 `trigger` 配对，所以计入分子的是 0——**闸门后的两次段抽取恰好是这条指标的正样本**：它们证明配对逻辑在两种 trigger 下都能咬合。

（§八 还有两行：单元测试 + 变异 ✅ 见 §二；收口 health-check 见 §五，retirements 翻 done 归 ⑤。）

## 四、发现了什么（没在这次修的）

1. **行 3 空样本**：跨天/容量触发待验收（规则 20/37——样本不足写「待验收」，不写「已通过」）。下次自然触发时 grep `segment flush: trigger=capacity|age` 补证。
2. **handoff 重启重发**（② 批发现，仍待定夺）：`handedOff` 是进程内 Set，重启即清空，同一会话会再收到一次相同 handoff（21:25、22:33 实测各一次）——决定 4 的「每会话至多一条」在重启边界实际按「每进程」计。归 ⑤ 一并决定持久化与否。
3. **quality 配对窗口 2000ms vs 实测 44–98ms**：若未来 extract 与 extract-queue 事件分离超过 2 秒，会被误判成「会话中调用」——误判方向是 fail loudly（多报违规而不是漏报），可接受；窗口改动要连着这个方向一起看。
4. **② 批的两条仍在**：rules floor 对段只看最后一轮（core 语义，未动）；`seed-backfill.mjs` 绕过写入器、reset-derived 不清 seals——归 ⑤。

## 五、结论

③ 把归属从「每轮一条线索」升到「段切出几条就写几条、每轮都挂上」，退掉的单条字段比新增的解析还难写对（两个真 bug 都在测试里先红了一次）；④ 把 0028 的验收从清单变成数字——四行里三行有生产日志逐条对上，一行诚实记「待验收」，指标本身能红。**离开点说了算**现在同时有代码闸门（②）、生产样本（行 1/2）和仪表盘（行 4）三层证据。下一步按 §九 走 ⑤：retirements 登记（extract-per-turn 翻 done、seed-backfill 绕写入器、reset 不清 seals）+ 0017/0034 指标口径改段级。
