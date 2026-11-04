# 2026-11-04 review：三条时间轴 + 人物卡（顺序第 2 步）

> A9 整体 review。对象：`valid_from` / `valid_until` 上线（v13）、`personCard`、插件 `<about>`
> 附带未闭合问题。

## 一、为什么加这两列

用户指出的问题：现在只有 `at`（事件时间）和 `created_at`（记录时间），少了「内容从什么时候
成立 / 到什么时候不再成立」。用实际数据说明它的必要性：

```
旧：一条“小林在 A 公司”（at 可空）被取代后，只剩 status=retracted
    能回答“她以前在 A 公司吗”，不能回答“现在还是不是”
新：valid_until 记下它停止成立的时间，valid_until 为空 = 当前仍成立
```

三条轴各答一件事：

| 列 | 回答 | 谁写 |
|---|---|---|
| `created_at` | 我什么时候记下它 | 代码，永不改 |
| `at` | 这件事什么时候发生 | 模型（事件才有） |
| `valid_from` / `valid_until` | 这条内容什么时候成立 / 不再成立 | 代码（默认 + 取代时写） |

## 二、改动

### 语义修正（2026-11-04，用户两次指出）

**第一次修正**：事件不是永久的——`valid_until = atEnd ?? at`，事件结束就不再是“当前”。

**第二次修正**：两条事实若是同一主题（都是小林），它们不是各自独立的区间：
“10-24 被裁员”**结束**了“在 A 公司”。状态的有效期终点 = 事件发生的时间，不是
“我记录这条的时间”。

```
"小林在 A 公司"   valid_from=入职   valid_until=10-24
"10-24 被裁员"    valid_from=10-24  valid_until=10-24
```

由此 `supersedeFact` 的关闭时刻改为 **后继事实的 `valid_from`**（没有才回落 `created_at`）。
语义判断仍归模型：它必须在抽取时输出「操作=取代 <旧 id>」；代码只负责用事件时间关闭，
不猜哪两条矛盾。

- v14 迁移：已有带日期的事实按 `COALESCE(at_end, at)` 关闭；
- 写入默认：`validUntil = 显式值 ?? atEnd ?? at ?? 空`；

- schema v13：`facts` 加两列，回填 `valid_from = COALESCE(at, created_at)`；已撤回的行回填
  `valid_until = 后继的 created_at`（当时没记事件时间，是近似；v14 对带日期的行改用 `at`）；
- `supersedeFact`：关闭时刻 = 后继的 `valid_from`（事件时间），状态仍是 `retracted`；
- `Soul.personCard(name)`：按名字/别名找到人，返回最近事实 + 挂着这个人的未闭合问题；
- CLI `soulbridge person <name>`；
- 插件 `<about>` 块：在事实行后追加最多 2 条 `- 未闭合：…`。

## 三、验证

```
core 298 测试（+6：event 关闭 / range 关闭 / valid_from 默认 / supersede 写 valid_until /
              v13 回填 / v14 关闭带日期行 / 人物卡按别名 / 未知名字返回 null）
插件 87 测试
```

过程中插件 hooks 测试先红了——因为 `openGapsAbout` 是 core 新导出，插件快照里还没有。
**测试先红是好事**：它证明这一步确实依赖新 core 版本，而不是“看起来能用”。

## 四、没做的 / 边界

- **不判断事件 vs 断言**：`at` 为空不代表它是状态，`valid_until` 也不代表它是事件。人物卡
  只是把最近事实列出来，不做“状态/事件”分类——那是模型该做的判断，代码不做；
- `at_end`（事件持续结束）与 `valid_until`（内容失效）是两件事，不要混用；这条写进了 spec；
- 人物卡不做摘要，也不判断“该不该问”；插件只多给两行未闭合问题，问不问由模型决定；
- 回填的 `valid_until` 用后继记录的 created_at，是近似——精确的“失效时刻”当时没记。
