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
