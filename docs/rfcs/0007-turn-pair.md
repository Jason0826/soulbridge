# RFC 0007：turn_pair —— 以交流为单位的记忆

- 状态：Proposed
- 日期：2026-10-31
- 需求说明：[briefs/0010-memory-unit.md](../briefs/0010-memory-unit.md)
- 阶段：[S2](../stages/s2-memory-unit.md)（MVP1）
- 前置验证：`_scratch/longmemeval/pair_test.py`（问答对 vs 单轮：R@5 80 vs 74）

---

## 1. 背景

现在的记忆是"抽取后的一句话"，边界从 7 字到 18202 字。由此产生三个已实测的问题：

1. **评分被长度扭曲**——一条 18KB 记忆进入 85% 查询的 top3（BM25 修到 15%，但那是治标）
2. **只存用户的话**——助手的回复不存，"交流"只剩一半
3. **无法回答"上次聊了什么"**——条目是结论，不是对话

需求说明 0010 已定：**一条记忆 = 一个交流单元（用户 + 助手）**。
本 RFC 定它怎么落库、怎么写入、怎么召回、旧数据怎么办。

## 2. 设计

### 2.1 Schema

新表，**不改造 `memories`**（它存的是提炼后的结论，职责不同）。

```sql
CREATE TABLE IF NOT EXISTS turn_pairs (
  id             TEXT PRIMARY KEY,        -- tp_<base36 time>_<rand4>
  soul_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,           -- 宿主会话 id
  turn           INTEGER NOT NULL,        -- 宿主 turn 序号，用于幂等
  at             INTEGER NOT NULL,        -- 用户消息的时间
  user_text      TEXT NOT NULL,           -- 原文，不截断
  assistant_text TEXT NOT NULL,           -- 原文，不截断
  metadata_json  TEXT NOT NULL DEFAULT '{}',  -- 三轴等未定字段（0010 §8）
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_pairs_scope
  ON turn_pairs(soul_id, user_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_pairs_turn
  ON turn_pairs(soul_id, user_id, session_id, turn);
```

**唯一索引就是幂等**：同一个 `(soul, user, session, turn)` 只能有一行，重复写入用 `INSERT OR IGNORE`。

**原文不截断。** 超长片段在**注入时**按预算整条跳过，不做半截截断——沿用 0004 的原则
（"never cut a sentence in half, drop whole memories instead"）。

### 2.2 写入路径

**难点：现在 `observe` 在用户消息时触发，助手回复还没产生。**

配对方案（插件侧）：

```
session/event type=user/message      → 暂存 { turn, text, at } 到 pending Map
session/event type=assistant/message → 取出 pending，写 turn_pair，清掉
```

规则：

| 情况 | 处理 |
|---|---|
| 正常一问一答 | 写入一对 |
| 助手回复分多段（流式） | 取**最后一段完整文本**，前面的丢弃（会造成不完整，见风险） |
| 下一条用户消息到来时 pending 还在 | 说明助手没回复（中断/出错），**丢弃 pending**，不写半对 |
| 插件重启 | pending 是内存态，丢失；宁可少记，不写半对 |

**只记 user 有实际文本的轮次**；纯工具轮、注入轮（`source.kind === 'memory-context'`）不记。

### 2.3 召回

新增 core 方法：

```ts
recallTurnPairs(spec: { soulId, userId, query, limit, since? }): TurnPair[]
```

- 打分沿用 `scoring.ts` 的 BM25，文档内容是 `user_text + '\n' + assistant_text`
- 返回按分排序的**片段**，不是 id 列表（调用方直接拿到文本）

**与 `memories` 并存，不互相替代：**

| 用途 | 数据源 |
|---|---|
| system prompt 锚点 | `memories`（importance ≥ 8，≤3 条） |
| pre-step 相关注入 | **`turn_pairs`**（本 RFC 新增） |
| `soul_recall` 工具 | 两者都查，结果合并后排序 |

这正是 0010 §10 的分工：**锚点放结论，pre-step 放片段。**

### 2.4 注入

pre-step 已经在 0.0.34 改成"只注入 `<memories>` 块、无匹配不注入"。本 RFC 只换**内容来源**：

```
block = turnPairs.map(tp => `- [Q] ${tp.userText}\n  [A] ${tp.assistantText}`).join('\n')
```

仍受字符预算约束：**装不下就整条跳过**，并记 `dropped`。

### 2.5 不变量

1. 同一 `(soul, user, session, turn)` 只有一行
2. 已写入的 `turn_pairs` 行**不可修改**（原文就是原文；派生视图另存）
3. 注入不截断，只整条丢弃
4. 注入内容不回写进记忆（沿用现有检查）
5. 插件崩溃/重启不得产生半对

## 3. 迁移

- **旧 `memories` 不迁移**。60 条是"结论"，`turn_pairs` 是"原文"，语义不同
- 新增 schema 版本 v4 → v5：只建表，不改旧表
- `PRAGMA integrity_check` 通过，备份可独立打开（沿用 S1 的 N0 修复）
- 回滚：删表即可，旧功能不受影响

## 4. 落地顺序

1. **migration + schema**（core `sqlite.ts`）
2. **core API**：`putTurnPair` / `recallTurnPairs` / `countTurnPairs`
3. **插件配对写入**（`session/event` 两个事件）
4. **pre-step 换数据源**
5. **观察**：真机出现 `turn_pairs` 行，日志有 `ids`

每一步都能单独回滚。

## 5. 验收

| # | 条件 | 怎么验 |
|---|---|---|
| 1 | 真机库有行 | `SELECT COUNT(*) FROM turn_pairs` > 0 |
| 2 | 一对完整 | 抽查 10 行，`user_text` 和 `assistant_text` 都非空 |
| 3 | 无重复 | 唯一索引冲突数 = 0 |
| 4 | 召回可用 | 新会话问旧话题，注入里有对应 `turn_pair` |
| 5 | 无半对 | `assistant_text = ''` 的行数 = 0 |
| 6 | MVP1 | [S2 四条判据](../stages/s2-memory-unit.md) |

## 6. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 流式回复只取最后一段 | 助手内容不完整 | 先接受；若抽查发现丢内容，再改成拼接所有段 |
| 体积增长 | 一年上万行 | 冷备，不进注入；只受"每轮注入条数"约束 |
| 长片段占位 | 一条长对话挤掉别的 | 注入时整条跳过；后续用提炼解决（MVP2 前） |
| 配对丢失 | 少记几轮 | 宁可少记，不写半对 |
| 中文召回质量未知 | 新会话接不上 | MVP1 判据会暴露；不行再调 |

## 7. 开放问题

1. **"超长"的阈值是多少？** 现在只有"按字符预算整条跳过"，没有提炼。等真实分布出来再定。
2. **`memories` 什么时候淘汰？** MVP1 阶段并存；MVP2（画像）上线后再决定。
3. **要不要给 `turn_pair` 也算 importance？** 现在没有，排序只靠 BM25 + 时间。可能不够，等数据。
4. **跨会话的 turn 序号会重复吗？** 不会——唯一索引里带了 `session_id`。
5. **推理过程要不要入 `metadata`？** 现在不存：`assistant/message.content` 是 `[reasoning, text]` 两段，只取 `text`。
   推理里有正文没有的东西（我对用户的判断、放弃的选项、自我纠正），但它是**过程**不是**交流**——用户看不到，
   体积是正文的 5–10 倍，且质量不稳定（走弯路、试错）。
   **改用条件**：如果出现"上次说 A、这次说 B 且用户没有改口"这类缺少自身立场的现象，
   再考虑往 `metadata.reasoning_summary` 放**摘要**（不是全文）。那属于"对自己判断的记忆"，
   比"交流记忆"晚一层，不在 MVP1。

## 8. 路线图

**不在 N1/N2/N3 任何一项上。**

| 问题 | 回答 |
|---|---|
| 推进了哪一项？ | **没有推进路线图条目**。它直接服务 S2 的效果目标 [MVP1](../mvp.md)，不是 N 系列的新增 |
| **挤掉了哪一项？** | **N2（审计留痕）和 N3（长会话提醒）**。S2 的预算（2 周 / 3 个版本）全给了 MVP1；这两项顺延到 MVP2 之后 |
| 不在路线图上，为什么现在做？ | S1 的失败是决定性的：四条判据里两条"无法判定"，而根因之一是**记忆单位没有原文可追溯**。不先定单位，N2 的"审计留痕"也无处可挂——它要追溯的正是"这条记忆从哪来" |

**这是一次主动的范围收缩，不是顺手加的。** 如果 S2 到期未达成 MVP1，N2/N3 会继续顺延，届时要在收尾记录里写明。

## 9. 设计交付门槛（四问）

### 9.1 何时可以实施

**前置（已满足）：**

- 需求说明 [0010](../briefs/0010-memory-unit.md) 已有验收标准
- S2 阶段文件已开（[s2-memory-unit.md](../stages/s2-memory-unit.md)）
- 检索层 BM25 已上线（core 0.0.24），`turn_pairs` 直接复用

**什么条件下不做：**

- 若 MVP1 的判据 3（可追溯）能被现有 `memories` 满足 → `turn_pair` 不必要。
  实测不满足：条目是抽取后的结论，没有原文，无法回答"上次聊了什么"。
- 若真机 `turn_pairs` 写入失败率过高（配对丢失 > 30%）→ 先修配对，不进入召回改造。

### 9.2 怎么实施

| 步骤 | 改哪里 | 中间状态是否可用 |
|---|---|---|
| 1. schema | `packages/core/src/sqlite.ts`（v5 migration） | ✅ 旧功能不受影响 |
| 2. core API | `store.ts` / `sqlite.ts` / `index.ts` | ✅ 只增不改 |
| 3. 插件配对写入 | `dsh-plugin-soulbridge/index.js`（两个 `session/event`） | ✅ 写了也不被读 |
| 4. pre-step 换数据源 | 插件 `buildRelatedContext` | ⚠️ 这是唯一的行为切换点，可回滚 |
| 5. 观察 | 无代码 | —— |

**每步单独提交，第 4 步是开关。**

### 9.3 如何验证

```powershell
# 1 有行
sqlite3 ~/.soulbridge/soul.db "SELECT COUNT(*) FROM turn_pairs"
# 2 无半对
sqlite3 ~/.soulbridge/soul.db "SELECT COUNT(*) FROM turn_pairs WHERE assistant_text=''"
# 3 无重复（唯一索引冲突应恒为 0）
sqlite3 ~/.soulbridge/soul.db "SELECT COUNT(*) FROM (SELECT session_id,turn,COUNT(*) c FROM turn_pairs GROUP BY 1,2 HAVING c>1)"
# 4 召回可用：新会话问旧话题，看 plugin.log 的 ids 是否指向 turn_pair
```

失败怎么发现：`turn_pairs` 行数长期为 0（配对没接上）；`assistant_text=''` 有行（写了半对）；注入 `ids` 为空但库里有行（召回没接）。

### 9.4 有没有消费者

| 消费者 | 现在有吗 | 用它做什么 |
|---|---|---|
| pre-step 注入 | ✅ **S2 内唯一消费者** | 提供"上次聊过什么" |
| `soul_recall` 工具 | ✅ 合并查询 | 模型主动查记忆时也能查到片段 |
| MVP2 归纳 | ❌ 未来 | 从片段归纳画像 |

**唯一消费者是 pre-step。** 这点要守住：如果 S2 结束时 pre-step 没用上，`turn_pair` 就是没有消费者的数据。
