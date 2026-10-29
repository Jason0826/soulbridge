# RFC 0006：在 agent/pre-step 注入上下文记忆

- 状态：Proposed
- 日期：2026-10-29
- 需求说明：[briefs/0004-memory-injection.md](../briefs/0004-memory-injection.md)
- 前置实验：`v0.0.26` 的 pre-step 探针

---

## 1. 背景

需求说明里测出：`systemPrompt.section` 在用户消息到达**之前**求值（早约 200ms），
所以第一轮回复无法按当前消息做相关性排序。

探针（`agent/pre-step`）验证了另一条路：

```
12:44:19.914  prestep: turn=153 step=1 msgs=1 kind=enter chars=4   ← 拿得到当前消息
12:44:26.394  prestep: turn=153 step=2 msgs=0 kind=enter chars=0
12:44:26.401  user/message source=user chars=37                    ← 追加内容被当成用户输入
```

结论：**window 存在**（payload 带当前消息，waterfall 可改 `messages`），
但探针同时制造了两个缺陷，正是本 RFC 要解决的。

## 2. 设计

### 2.1 注入点

`ctx.on('agent/pre-step', async (payload, next) => …)`，在 `next()` 之后修改它的返回值。
不再用 `systemPrompt.section` 承载"相关记忆"。

`systemPrompt.section` 保留，但只放**锚点**（见 2.3），因为它早于消息、无法做相关性。

### 2.2 幂等（必须）

| 维度 | 做法 |
|---|---|
| **按轮** | `Map<sessionId, turn>`；同一 turn 第二次进入直接返回原 decision |
| **重试** | 同上，键是 turn 而不是 step，重试的 step 不会重复注入 |
| **跨会话** | 键包含 sessionId，不同会话互不影响 |

上线后旧条目要能自然失效：`Map` 只保留最近 N 个会话（例如 8），避免无限增长。

### 2.3 内容

```js
query = 当前轮最后一条用户消息（payload.messages 的最后一条）
block = soul.context({ query, types: ['strategy','fact','trait'], minImportance: 6, maxItems: 5 })
```

- `query` 为空（纯工具/恢复的 step）→ 跳过注入
- 没有匹配 → 只注入锚点（`importance ≥ 8`，最多 3 条）；锚点仍走 section，不重复追加
- 追加内容**不是** system prompt，而是一条消息，必须带可识别的来源

### 2.4 来源隔离（必须）

追加的消息用**专属来源**：

```js
{ id: `memctx_${turn}`, role: 'user', content: [...], source: { kind: 'memory-context' } }
```

- 插件的 `session/event` 只处理 `source.kind === 'user'`，因此不会被 `observe` 认领
- 导出/转写时可通过 `memctx_` 前缀过滤
- **不允许**用 `source.kind: 'user'`——探针证明那会导致注入内容写进记忆库

### 2.5 失败与预算

- 任何异常：记日志、返回原 decision，**绝不阻断这一轮**
- 检索是本地同步 SQLite，预期 < 5ms；不设超时（设了也无法中断同步调用）
- 每轮最多追加 1 条，字符预算沿用 `context` 的 `maxChars`

## 3. 验证

| 项 | 方式 |
|---|---|
| 窗口可用 | 探针已证（turn/step/msgs 可见） |
| 按轮幂等 | 单测：同一 turn 调用两次 handler，messages 只增加一次 |
| 重试幂等 | 单测：同 turn 不同 step，只注入一次 |
| 来源隔离 | 单测：追加消息不出现在 `session/event` 的 observe 路径 |
| 相关性 | 手工：问数据库相关的问题，注入出现"数据库使用 SQLite"而非无关条目 |
| 无匹配 | 手工：闲聊时不追加记忆消息 |
| 不阻断 | 单测：检索抛错时返回原 decision |

## 4. 实施顺序

1. 抽 `buildMemoryContext(text)`（纯函数，可测）
2. 改写 pre-step handler：幂等 + 来源标记 + 失败兜底
3. section 只留锚点（`importance ≥ 8`，maxItems 3）
4. 日志：`prestep: inject turn=.. items=.. chars=..` / `prestep: skip (already)`
5. 关闭探针开关（`preStepProbe` 只剩调试用途）

## 5. 何时可以实施

- **现在**：窗口已验证，core 的 `context({query})` 已支持
- 依赖：无
- 不做的情况：如果追加消息会破坏会话历史的可读性（用户在 UI 里看到自己的消息里混入记忆块），
  则改为在 `messages` 前面插一条 assistant 角色的旁注，或退回"section 锚点 + 工具召回"

## 6. 开放问题

1. 追加消息会不会显示在 GUI 的对话记录里？探针期间我没在界面上确认。
2. 对 prompt 缓存的影响：每轮内容不同，可能使系统提示词缓存失效率上升。
3. 锚点与相关层要不要互相去重（同一条既在锚点又在相关里）？
4. `maxItems` 与 `minImportance` 的默认值是否需要按真实使用调整？
