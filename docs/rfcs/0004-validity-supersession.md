# RFC 0004：记忆的时效与取代

- 状态：Accepted（0.0.15 实现）
- 日期：2026-10-29
- 需求说明：[briefs/0001-validity-conflict.md](../briefs/0001-validity-conflict.md)
- 路线图：N3

---

## 1. 目的

让"旧值"和"过期内容"不再进入 prompt。需求说明里的场景：先记"发布窗口是周三"，
三周后改成"周四"，今天两条都会注入。

## 2. 消费者与决定

沿用需求说明，实现层面的落点：

| 消费者 | 落点 | 需要的判据 |
|---|---|---|
| 注入构建器 | `buildContext` 的候选集 | 未过期 且 未被取代 |
| 按需召回 | `Soul.recall` | 同上 |
| 记忆列表 | `soulbridge list` | 显示状态，包括被取代的 |
| 显式取代 | `soulbridge supersede <old> <new>` | 操作者判断 |

## 3. 关键设计决定：v0 不做自动冲突判定

需求说明的第 7 节把"冲突判定规则"留给了设计阶段。推演了三种确定性规则，**都不可靠**：

| 候选规则 | 反例 | 结论 |
|---|---|---|
| 同类 + 关键词重叠 ≥ 0.6 | "提交前先跑测试" vs "提交前先跑 lint"：二元组高度重叠，但这是两条不同规则 | ❌ 误取代 |
| 最长公共前缀 ≥ 4 字 | 同上，共享"提交前先跑" | ❌ 误取代 |
| 同实体名 + 谓词不同 | 需要实体抽取，没有可靠的确定性实现 | ❌ 做不到 |

**误取代比不取代更糟**：旧规则被悄悄停用，用户不知道。

因此 v0 只做两件确定性的事：

1. **过期过滤**（`validUntil`）：判据完全确定，无歧义
2. **显式取代**（`supersede`）：由人触发，模型/规则不参与

需求说明因此修订一条：原"必须：写入冲突条目时自动置 superseded"改为
"**应该**：提供显式取代接口，自动判定列为不做"。

## 4. 实现

### 4.1 查询过滤

`sqlite.query` 的 WHERE 增加：

```sql
AND (valid_until IS NULL OR valid_until > ?)
```

`recall` 走同一个 `query`，自动继承。

### 4.2 显式取代

```ts
// store 端口新增
supersede(oldId: string, newId: string, now?: number): boolean;
// UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=? AND status='active'
```

- 返回 false 表示旧条目不存在或已被取代（幂等，不报错）
- **不删除**：`list` 仍可查到，`context` 因状态过滤而排除
- `supersede` 需要一个"新"条目存在，否则拒绝

### 4.3 CLI

```bash
soulbridge supersede <old-id> <new-id>
soulbridge list            # 状态列显示 active / superseded / archived
soulbridge status          # 有效 / 被取代 / 已过期 三类计数
```

## 5. 验证

| 项 | 方式 |
|---|---|
| 过期不进 context | 单测：`validUntil = now-1` 的记忆不在 `used` 里 |
| 过期仍在 list | 单测：`list` 返回它 |
| 取代后不进 context | 单测：`supersede` 后旧条目不出现 |
| 取代后仍可查 | 单测：`list` 返回且 `status='superseded'`、`supersededBy` 正确 |
| 取代幂等 | 单测：二次调用返回 false，不抛错 |
| 回归 | 既有 84 条测试全绿 |

## 6. 何时可以实施

- **现在**：schema 已含 `valid_until` / `superseded_by`，无需迁移、无需模型
- 依赖：无
- 不做的情况：若发现 `query` 的 WHERE 改动影响性能（候选集通常 < 数百条，不预期）

## 7. 遗留

- 自动冲突判定推迟到有可靠信号（例如模型提炼 + 人工确认，见 RFC 0003 B 阶段）
- `validFrom` 无独立消费者，本 RFC 不实现；下次 schema 变更时移除或降级为别名
- 取代链只记直接前驱，不做链式回溯
