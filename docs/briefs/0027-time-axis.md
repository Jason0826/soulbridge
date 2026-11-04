# 0027 事实的时间：valid_from / valid_to，由模型判定

- 状态：已定（2026-11-04 20:20），待实施
- 触发：用户指出 `at` 这个名字看不懂（"起变量名也要能说明这个变量是做什么的"）；并且
  "BOM 是全局教训"应当**从说出口那一刻起成立**——不能因为"不知道"就留空。
- 关系：抽取单位（一条主题一次，不是按轮）见 [0025](0025-thread-extraction.md)，本 brief 只定时间。

## 一、问题（2026-11-04 20:15 实测）

表里现在是**四列时间**：`created_at` / `at` / `at_end` / `valid_from` / `valid_until`。

```
事实 860 · 有 at 242 · valid_from 有值 860（全是 COALESCE(at, created_at) 的拷贝）
valid_until 有值 298 · 其中 = at 的 242（**有日期的全部**）
这 242 条里 status=active 236 条 —— 活着，却已经"失效"
at_end 使用次数 0
at_precision=unknown 606（70%）
```

`valid_from` 模型一次都没给过，`at_end` 从没被写过，`valid_until` 是代码按"有 at 就当事件、当天结束"
推出来的。于是"当前"查询（`valid_until IS NULL OR valid_until > now`）把 236 条正确判断排除在外。

**根因不是数值错，是两个名字（`at` / `valid_from`）都指向"内容从什么时候成立"，却各写了一份，其中一份还被拿来推"失效"。**

## 二、决定：两条轴，三个名字（都自解释）

| 列 | 回答什么 | 谁写 |
|---|---|---|
| `created_at` | 我什么时候**记下**它 | 代码，永不改 |
| `valid_from` | 这条内容从什么时候**开始成立** | **模型判定** |
| `valid_to` | 这条内容从什么时候**不再成立**（空 = 仍成立） | **模型判定**；取代时也写这里 |

属性（不是第三条轴，只是 `valid_from` 的注脚）：

```
valid_from_text       原话（"上周三" / "初次见面时"）
valid_from_precision  day | range | relative | unknown
```

**废弃 `at` / `at_end` / `valid_until` 三个名字**——它们和 `valid_from` / `valid_to` 是同一件事的
两种写法，而"两种写法"正是这条 bug 的来源。

## 三、判定规则（写进抽取提示词，一处维护）

| 情况 | valid_from | valid_to | 例 |
|---|---|---|---|
| **事件**（发生了某事） | 发生时间 | 空（历史事件永远成立） | 2024-10-24 被裁员：from=10-24，to=空 |
| **状态**（一直成立） | 开始成立时 | 不再成立时，不知道就空 | 小林在 A 公司：from=2020-03，to=2024-10-24 |
| **断言/判断**（"BOM 是全局教训"） | **说这句话那天** | 空 | from=2026-11-03 |
| **计划/约定**（"从下周一起每天 9 点"） | 生效日 | 空（或被取消那天） | from=下周一 |
| 有明确区间的**事件**（"会议 9 点到 11 点"） | 开始 | 结束 | from=9:00，to=11:00 |
| 拿不准具体时刻 | 空 + `precision=unknown`，**同时开一个缺口** | 空 | "上次和 a 吃饭" |

**两条硬规则**：

1. **断言类不许留空**：你说出来它就成立，`valid_from = 说话那天`。"不知道"不是留空的理由。
2. **`valid_to` 永远不从 `valid_from` 推导**。只有三种来源：模型明确说结束、被新事实取代
   （旧 `valid_to` = 新 `valid_from`）、`status=retracted`（记录本身错了，`valid_to` 不动）。
   **代码不再猜。** 纠正也走"取代"：纠正是一条新断言，`valid_from` = 纠正那天，
   旧断言的 `valid_to` 由此得到（见 §七.1）。

## 四、边界

| 不做 | 为什么 |
|---|---|
| "事件 / 状态"类型字段 | 用区间表达（`valid_to` 关没关）；同一件事不需要两个表示 |
| 回溯修正所有历史 `valid_from_text` | 原话是证据，改了就不再是证据 |
| 时间归一（"上周三"→具体日期） | 那是下一步的独立改动，本 brief 只定字段与判据 |
| 用 `at` / `at_end` / `valid_until` 继续写 | 命名不清 = 下一个人（包括我）会再猜一次 |

## 五、迁移（schema v15，一个事务）

```
1  备份：soul.db.bak-v15-<ts>（VACUUM INTO + 完整性校验）
2  重建 facts 列集合：valid_from / valid_to / valid_from_text / valid_from_precision
   valid_from = COALESCE(at, created_at)          ← 断言类的 at 恰好就是"说出口那天"，正确
   valid_to   = at_end                            ← 区间事件（当前 0 条）
              ∪ status='retracted' 的旧 valid_until ← 取代写入的，语义正确（56 条）
   **丢弃**：active 且 valid_until = at 的 236 条 ← 猜测产物
3  版本号与数据同一个事务；失败整体回滚
```

## 六、验收（可执行）

```
node scripts/health-check.mjs                     → 0 FAIL
sqlite: SELECT COUNT(*) FROM facts WHERE status='active' AND valid_to IS NOT NULL
                                                   → 只剩真正结束的（当前应 < 10）
sqlite: SELECT COUNT(*) FROM facts WHERE valid_from IS NULL
                                                   → 新写入的断言类应为 0
新抽 10 条事实：断言类 valid_from=当天、valid_to=空；状态类区间正确
`当前` 查询命中数：236 条被误排除的回到结果里（前/后对比写出数字）
```

## 七、开放问题

1. **已定（2026-11-04 20:25，用户）**：断言被证明是错的时候，**`valid_to = 纠正那天`**，不是 `retracted`。
   理由是纠正属于"认知变了"，那条断言在被纠正之前**是真的**（我们按它行动过），
   抹掉就答不了"你当时为什么建议先做 A"。
   于是三种"结束"各归各位：

   | 什么变了 | 怎么结束 | 例 |
   |---|---|---|
   | 世界变了 | 旧状态 `valid_to` = 结束它的事件的 `valid_from` | 小林离职：在 A 公司到 10-24 |
   | 认知变了（纠正/改主意） | 旧断言 `valid_to` = **新断言（纠正）的 `valid_from`**，即纠正那天 | BOM 是全局教训 → 11-05 被纠正 |
   | 记录本身错了（编造/重复/误记） | `status=retracted`，**`valid_to` 不动**（它从来没成立过） | 模型编了一条没发生过的事 |

   这样"纠正"不引入第二套机制：它和新状态一样走取代，一条边、一个时间来源。
2. 一条事实里出现两个时间（"上周投了简历，这周收到面试"）——是不是该拆成两条？倾向拆。

## 八、读取方（还没接线，但用法现在定死）

`valid_from_text` 与 `valid_from_precision` **不是"没有消费者的字段"**，是读取侧还没建。四个已定的消费者，
写在这里是为了以后别把"还没接线"误读成"该退场"：

| 消费者 | 用它做什么 | 为什么非它不可 |
|---|---|---|
| **时间检索** | "上周发生了什么"只在 `precision ∈ {day, range}` 的事实里按 `valid_from` 过滤；`relative` / `unknown` **不参与区间过滤**（只作为"提到过"的弱命中） | 否则会把"**我记下它的那天**"当成"**事情发生的那天**"——正是 v14 那 247 条错误的同类 |
| **排序与比较** | 两条事实比早晚时，`unknown` 那条只能标"约"，不能宣称更早/更晚 | `valid_from` 是 `created_at` 的占位时，精确比较就是假精确 |
| **注入措辞** | `day` → "2026-10-28"；`range` → "10 月下旬"；`relative` → "上次"；`unknown` → "具体哪天记不清了" | 用户能看出"它记得准不准"，而不是被一个假日期骗 |
| **追溯** | 用户问"你凭什么说是 10-28" → `valid_from_text` 给原话，`precision` 说明这是换算还是原话直说；`soulbridge why` 一并打印 | 换算是会错的，没有原话就永远查不出错在哪一步 |

**一个反直觉的边界**：`precision=unknown` 的事实在检索里**不能被过滤掉**——只是不能参与"范围查询"。
过滤掉就等于"时间不明即不存在"，那会丢掉真实记忆（0019 的遗忘不是靠删，是靠降权）。

**接线时要加的验收**（现在写下来，免得接线时又临时拍）：

```
时间查询"上周"    → 结果里 100% 是 day/range；unknown 一条都不进
问"那次吃饭是哪天" → relative 的那条回答"只知道是上次"，不编日期
`soulbridge why`  → 打印 text + precision + 换算后的日期三样
```

## 九、实施进度：读取方 1（时间检索），2026-11-04

已实现（core 0.0.114；插件注入在 `dsh-plugin-soulbridge` 0.0.115 同批落地）：

```
路由      planRetrieval 的 time 分支带 window（cue → [from, to)）；解析不了（那天/月初）
          不带窗口，reason=`time cue, no window` —— 「没有记录」与「不知道哪一天」可区分
解析      time.ts findWindow：TIME_CUE 从 retrieval.ts 移到 time.ts（唯一声明），
          resolveRelativeTime 拿到第一个读者；ResolvedTime.precision 改用 AtPrecision
查询      Soul.factsInWindow({from,to})：valid_from ∈ [from,to) ∧ precision ∈ {day,range}
          ∧ status=active；WINDOW_PRECISIONS 在 config/status.ts 一处声明
语义      facts() 的 until 改成半开 [since,until)：窗口的结束就是下一个窗口的开始
验收      7 条测试（core/test/time-window.test.ts）：findWindow（周/日/解析不了）、
          plan 带窗口、unknown/relative/retracted 不进窗、右端归属下一个窗口、空窗口是空答案
变异      去掉精度过滤 → 「only day/range facts enter」变红（已跑）
```

两个已定的判断，写下来免得下次重猜：

1. **`relative` / `unknown` 不进窗口查询，但也没有被删掉**——实体时间轴、相关式、钩子照常取到它们。这就是「不能被过滤掉」的落点：过滤掉的只是「范围查询」这个入口，不是记忆本身。
2. **「10月24日」暂不解析**：没有年份的日期要猜年份（今年？去年？），猜年份就是这条 brief 反对的假精确。这类问句照旧路由到 time、不带窗口、退回相关式，日志可查（`time cue, no window`）。要接它，得先定「年份从哪来」，那是一次独立改动。

仍未接线（0027 §八 另外三个读者）：`<time-window>` 之外的注入措辞、排序与比较、追溯（`soulbridge why` 打印 precision）。
