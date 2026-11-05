# 整体 review：0027 读取方 1（时间检索接 precision）

- 日期：2026-11-04
- 批次：core `1a9eba4`（0.0.114）+ `9377154`（棘轮记账）；插件 `1f73010`（0.0.115）
- brief：[0027 §八/§九](../briefs/0027-time-axis.md)
- 判定：**通过**。一条新读取路径，没有第二套表示；旧路径（相关式兜底）保留且有明确理由。

## 一、这次加了什么

| 位置 | 加了什么 | 为什么在这里 |
|---|---|---|
| `config/status.ts` | `WINDOW_PRECISIONS = [day, range]` | 值域声明只此一处；代码与 SQL 都从它绑定 |
| `time.ts` | `TIME_CUE`（从 retrieval.ts 移入）、`findWindow`、`TimeWindow` | 时间词汇与日历算术本来就该在一起；`resolveRelativeTime` 从此有了读者（之前 130 行零调用方） |
| `retrieval.ts` | plan 带 `window`；cue 可解析才带，`reason` 写明 `no window` | 路由仍是规则，不调模型；解析失败与"没有"可区分 |
| `sqlite.ts` | `facts()` 的 `until` 改为半开；新增 `precisions` 过滤 | 窗口的结束就是下一个窗口的开始；精度过滤是这次的核心闸门 |
| `index.ts` | `Soul.factsInWindow(window, {limit})` | 取数原语走 `SoulStore`（ADR 0028 第 4 条） |
| 插件 `index.js` | `planBlocks.window`、`renderTimeWindow`、`buildRelatedContext` 接线 + `trace: time_window` | 注入措辞归宿主（ADR 0024 分工） |

## 二、检查结果（都是跑出来的）

```
core     308 测试全过（+7：time-window.test.ts）· tsc --noEmit 干净
变异     去掉精度过滤 → 「only day/range facts enter」变红；恢复后变绿
插件     98 测试全过（+4：planBlocks window 开关、renderTimeWindow 两条、端到端注入一条）
         端到端那一条在 core 0.0.113 上红（factsInWindow 不存在，被 catch 吞成"无块"），
         装 0.0.114 后变绿 —— 依赖顺序验证过，不是"碰巧绿"
health   0 FAIL / 19 WARN（均为此前已存在的债）
```

## 三、合起来看：有没有更绕

- **没有第二套精度判定**：插件不做 precision 过滤，只渲染；判定只在 `WINDOW_PRECISIONS` + SQL 一处。
- **没有删旧路径**：`relative` / `unknown` 事实仍由实体时间轴、`<related>`、钩子取到——0027 §八 的"不能被过滤掉"落在"只把范围查询这一个入口收窄"上。
- **失败可区分**：三档现在都可见——窗口解析不了（`reason=time cue, no window`）、窗口解析了但为空（块里明说"没有记录"）、有结果（带日期）。
- **多花的东西**：时间问句的注入最多多 10 行 + 一行表头；每条此类问句 trace 多一个 `time_window` 事件。

## 四、发现了什么（没在这次修的）

1. **`extract.ts` 的 `PRECISIONS` 集合是 `AT_PRECISION` 的第二份拷贝**（health-check 第 8 节一直 WARN 着）。这次把 `time.ts` 的类型改成引用 `AtPrecision`，但 `'unknown'` 等字面量在 `extract.ts` / `sqlite.ts` / `time.ts` 里仍各写一遍。→ 单独一次"精度值域收口"，会碰到抽取解析器，不在本次范围。
2. **日期显示两套口径**：钩子路径用 `toISOString()`（UTC 日），新的窗口块用本地日。对模型写入的 UTC 零点时间戳两者一致；但规则抽取路径写的是 `now ± n 天`（带时刻），本地 00:00–08:00 之间会差一天。→ 显示口径统一是独立改动；已在新块里选本地口径并注释。
3. **「10月24日」不解析**（0027 §九 已写）：无年份的日期要猜年份，猜就是假精确；这类问句退回相关式，trace 里可见。
4. **`facts()` 的 `until` 语义从闭区间改成半开**：现有调用方没有一个传过 `until`（`factsAbout` 只在测试里用过 `since`），所以是零行为变更；测试里补了边界断言。
5. **npm 发布读侧有复制延迟**：CI 的 Publish 步骤成功后约 3–10 分钟，`registry.npmjs.org/<pkg>/<ver>` 与 `npm view` 才看得到新版本（core 0.0.114 实测）。验收脚本"装完再查版本"要等，否则会误判成发布失败。

## 五、结论

一次改动只接一个读者，没有顺手改措辞/排序/追溯（0027 §八 剩下三个读者仍待接）。系统比改前多一条取数路径，少一次"把记下那天当事发那天"的机会。

---

## 追加（2026-11-05）：写入侧收口 —— 发现 ② 已修，① 的近亲另修

读取方 1 上线后第一个数据结论：**「上周」窗口 87 条里只有 2 条可定位**——薄不在检索，在写入侧。批次：core 0.0.115 + 插件 0.0.116。

| 原发现 | 现状 |
|---|---|
| ② 日期显示两套口径 | **已修**：日历日统一为 UTC 零点（`time.ts` 四个 `start*`、窗口边界、插件 `isoDay`；钩子本就 `toISOString`）——显示与存储同一单位 |
| （新）规则抽取粗略偏移 + 假 day | **已修**：`findTime` 改走 `findTimeExpression`（与窗口同一词表），`TIME_WORDS`/`TIME_OFFSET_DAYS` 删除；"上周" → range + 周一零点，"2026年10月" → range |
| ① PRECISIONS 字面量副本 | 仍未修（独立一次收口） |
| ③ 10月24日不解析 | 仍按设计（0027 §九.2） |
| ④ until 半开 / ⑤ npm 读侧延迟 | 上一批已做 / 已记 state.md 环境栏 |

检查（跑出来的）：

```
core 310（+2：range+周一零点 / day+当天零点）· 插件 98 · typecheck 干净
变异 = 改动前状态本身：5 红 → 改后全绿
真实库：day/range 非日历日 2 → 0（quality.mjs 新增观测行 PASS）
```

**新发现（过程层，差点假绿）**：修存量行的脚本用了 `date(<epoch秒>)`——这个 SQLite 把 `date()` 的数字参数当**儒略日**（`julianday(int)` → null；`date(int,'localtime')` → `2000-01-01`），两行被写成 2000-01-01；而观测只查"是不是零点"、不查"是哪一天"，显示 PASS。靠**读实际值**发现，用 JS 算好的字面量改回（备份 `soul.db.bak-daymidnight-*`）。教训：**验证值，不只验证不变量的形状**——watcher 守的是"以后的写入者"，守不住"修数据的脚本"。

结论：0027 的两套时间语义病灶（② + 写入侧假精确）已除；余债清单见 0027 §十 末尾（词表两份、日历校验两份、窗口入口未唯一、unknown 行按设计不进窗）。

---

## 追加（2026-11-05）：抽取的取舍可见（同会话第三批，core 0.0.116 / 插件 0.0.117）

上一批 review 里我自己点出的两个欠账——"规则路径丢弃不可见"（规则 18）和"statement 切 80 字"（规则 17）——这次修掉。

| 欠账 | 修法 |
|---|---|
| 丢弃不可见 | `ExtractDraft.skipped: Array<{what, reason}>`：规则路径的无结构句子（`no-structure`）、模型路径的坏条目（`bad-entity-type` / `unreadable` / `unknown-op` / `empty-topic`）全部入列。插件在 `extract ok:` 行加 `draftSkipped=N` + 前 3 条明细，trace 加 `draftSkipped`（前 5 条） |
| 切半句 | `toStatement` 去掉 `slice(0, 80)`——陈述是整句；长度由注入侧按整行取舍（那里本来就是丢整行，不丢半句） |

```
core 314（+4：规则丢弃可见 / 长句整句 / 模型坏事实 / 坏实体类型）· 插件 98 · typecheck 干净
变异 = 改动前状态：4 红 → 绿
```

**顺带清掉一处死代码**：`validateDraft` 里的 `knownFactIds` 从未被读（supersede 目标早已交给 commitDrafts 校验），删除并在参数处写明。

**仍未修（同批 review 的余债，不变）**：`PRECISIONS` 字面量副本、`TIME_CUE` 与语法词表两份、`calendarDate`/`parseIsoDay` 两份、`facts(since/until)` 未收成唯一入口。另：`parseLineDraft` 里"不是记录格式的行"仍然静默跳过——本次只覆盖了 `validateDraft` 层的丢弃，行级噪声按"不是候选"处理，未计数。
