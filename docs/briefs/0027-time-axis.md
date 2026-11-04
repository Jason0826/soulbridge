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
   （旧 `valid_to` = 新 `valid_from`）、人工撤回。**代码不再猜。**

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

1. 断言被**证明是错的**时怎么办？`valid_to=纠正那天` 还是直接 `retracted`？——两者语义不同
   （内容曾经成立过 vs 从来没成立过），倾向 `retracted` + 保留 `valid_from`。
2. 一条事实里出现两个时间（"上周投了简历，这周收到面试"）——是不是该拆成两条？倾向拆。
