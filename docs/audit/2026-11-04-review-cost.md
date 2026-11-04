# 整体 review：0026 成本可见（2026-11-04 19:30）

> checklist A9：一项做完要整体看一遍，不是再跑一次检查。
> 改动范围：插件 `index.js` + `test/turn-cost.test.mjs`；账单脚本与说明在**插件仓库**（见第六节"归属修正"）。
> 一句话结论：**钱有了唯一出口，轮有了唯一计数；观测量增了 174 行，语义没变——但这套东西不属于记忆层，已搬出本仓库。**

## 一、新增了什么

| 东西 | 在哪 | 消费者 |
|---|---|---|
| `turn-cost` 记录（每轮一条） | `trace.jsonl` | 人看、`quality.mjs`（下一步） |
| `turn cost:` 日志行（≥30 请求） | `plugin.log` | 人看 |
| `billing.mjs` + `docs/cost-visibility.md` | 插件仓库（19:43 从本仓库移出） | 人看、`state.md` 的成本数字来源 |

## 二、有没有出现"同一件事的第二个表示"

| 候选 | 判断 |
|---|---|
| `turn-cost` 的请求数 vs `trace` 里的 `message` 记录 | **不是**：`message` 是每步一条（含 usage），`turn-cost` 是每轮一条（含插件自己的调用与失败尝试）。粒度不同，且后者能从前者重建——重建不出来的是插件调用那部分，那部分本来就不在 `message` 里 |
| `billing.mjs` 的金额 vs 平台导出 | **不是**：脚本不产生金额，只重算导出里的 `price×amount` 做对账；差额 >1% 就 WARN |
| 插件里的金额估算 | **没有**。价目有峰谷两档（导出里同一 token 类两个单价），抄进代码就是第二份真相 |

## 三、旧的东西有没有退场

- 没有新表示取代旧表示，`retirements.json` 不需要改。
- **发现一处该退场的调试输出**：`plugin.log` 里 `session/event type=… eventKeys=… dataKeys=… sessionKeys=…` 每个事件一行，今天 4,924 行 / 17MB，把 `turn cost:` 淹了。它当初是为了摸清事件形状，形状已经清楚。**本轮不动**（不属于成本这件事），进待办。

## 四、指标变了吗

| 指标 | 改前（state.md 旧表） | 实测（`quality.mjs --days 7`） | 判断 |
|---|---|---|---|
| 事实密度 | 0.73 条/轮 PASS | **1.9 条/轮 FAIL**（760/401） | 0025 改成按线索抽取后，一轮产多条事实是设计使然；**通过线 ≤1.5 是按"每轮一抽"定的，需要重新校准**——不是本改动引起的 |
| 结论支持率 | 100%（5/5） | **65.9%（27/41）** | 样本从 5 涨到 41，旧结论"支持率 100%"是小样本假象。**新出现的不达标要单独查**，不在本轮范围 |
| 抽取走模型 | 99.3% | 99.1% | 稳定 |
| 情绪非零率 | 2.4% | 2.5% | 仍是词典地板，未接模型 |

`turn-cost` 本身不改任何比率：它只往 `trace.jsonl` 加一个 `event` 值，`quality.mjs` 按 `event` 过滤，读不到它。

## 五、系统更简单还是更绕

- 插件 +174 行（棘轮已记账）：一个纯函数 + 三处接线（`apply` 建、事件流喂、`makeLlm` 计插件调用）。没有新服务、没有新文件、没有新配置项。
- 金额的路径变简单了：以前"平台导出 → 人肉加"，现在"导出 → 一个脚本 → 一张表 + 一次对账"。
- 代价说清：`trace.jsonl` 每天多 34 条；`plugin.log` 每天多约 9 行（阈值以上）。都不设轮转变更（trace 已有 10MB 轮转）。

## 六、归属修正（19:43）

用户问了一句：「这个部分计算花费的部分，不是 soulbridge 应该有的东西吧？」

对。核查结果：

```
packages/core/src 里没有一行价格逻辑（cost|price|billing 只命中三处字符预算注释）
token 全是中文分词，不是 LLM token
```

所以错不在产品，在**我放文件的位置**：账单脚本读的是平台导出的 CSV，一个字节的 soulbridge
数据都不用；更糟的是我给它编了 `briefs/0026` 的号，等于把"看账单"登记成了产品需求。

已处置：

| 东西 | 从 | 到 |
|---|---|---|
| `scripts/billing.mjs` | soulbridge | `dsh-plugin-soulbridge/scripts/`（与 `trace-stats.mjs` 同类） |
| 说明文档 | `docs/briefs/0026-cost-visibility.md` | `dsh-plugin-soulbridge/docs/cost-visibility.md` |
| 本仓库 | 只留数字（`state.md` 的成本行）+ 一张"已移出"登记 | — |

`turn-cost` 留在插件里，理由：它是插件唯一能看到的数字，0024 §3 的调用预算要用它，且它只记
请求与 token、不算钱。**编号 0026 不回收**，留给以后真正的产品需求。

## 七、待办（进 backlog，不混进本次）

1. `plugin.log` 的逐事件调试行退场（见第三节）。
2. `quality.mjs` 读 `turn-cost`，把"每轮请求数分布"变成第五个指标，并重新校准事实密度通过线。
3. 结论支持率 65.9% 的原因（是验证 prompt 太严，还是线索级抽取让证据对不上）。
4. 子代理请求滚到父轮（需要 DSH 暴露会话谱系，事件流里没有）。

## 八、这次改动的证据

```
插件 21 个测试文件全过（新增 turn-cost 6 条）；core 49 个测试文件全过
npm test（插件 94 / core 302）全过
node scripts/billing.mjs --days 4  → 11/01–11/04 ¥100.22，单价重算差 0.00%（19:43 起在插件仓库跑）
node scripts/review-probes.mjs     → 8 段全绿
node scripts/health-check.mjs      → 0 FAIL / 17 WARN / 26 PASS
部署后首轮实测（19:36）：turn 2 → requests=5（steps=4 plugin=1）input=4272 cacheHit=848128 output=7754 secs=24
```
