# RFC 0005：DSH 工具 soul_recall / soul_remember

- 状态：Proposed
- 日期：2026-10-29
- 需求说明：[briefs/0002-dsh-tools.md](../briefs/0002-dsh-tools.md)
- 路线图：N1（DSH 工具）

---

## 1. 注册方式（已在真实插件中验证）

`dsh-wechat` 的可用写法：

```js
ctx.inject(['tools'], (toolsCtx) => {
  const tools = toolsCtx.get('tools');
  if (!tools) return;
  const dispose = tools.register({
    name, description,
    parameters: { type: 'object', properties: {...} },
    output: { schema: {...}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { return value; },
  });
  ctx.effect(() => dispose);
});
```

要点：

- `inject` 让注册等 `tools` 就绪；**失败不影响插件本体**，因为它在 `apply` 内部按需调用
- `register` 返回 dispose，必须挂在 `ctx.effect` 上，否则热重载会重复注册
- `execute` 返回的对象必须匹配 `output.schema`

## 2. 工具定义

### 2.1 `soul_recall`

```json
{
  "name": "soul_recall",
  "description": "按关键词从长期记忆里召回相关条目。当用户提到过去说过的话、偏好、约定，或你不确定某事是否记过时使用。返回按相关性排序的条目。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "检索关键词，通常是用户当前问题里的主题词" },
      "limit": { "type": "number", "description": "返回条数，默认 5，上限 20" }
    },
    "required": ["query"]
  },
  "output": {
    "schema": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "ok": { "type": "boolean" },
        "count": { "type": "number" },
        "memories": { "type": "array", "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "id": { "type": "string" }, "type": { "type": "string" },
            "content": { "type": "string" }, "score": { "type": "number" }
          }, "required": ["id", "type", "content", "score"]
        }},
        "reason": { "type": "string" }
      },
      "required": ["ok", "count", "memories"]
    }
  }
}
```

行为：调用 `Soul.recall(query, limit)`，它会计入召回（`recallCount++`、`lastRecalledAt`）。
失败（库不可用）返回 `{ok:false, count:0, memories:[], reason}`。

### 2.2 `soul_remember`

```json
{
  "name": "soul_remember",
  "description": "把一件值得长期记住的事写进记忆。只在用户明确要求记住、或确认这是一条长期约定/偏好时使用；不要用它记录一次性的临时信息。",
  "parameters": {
    "type": "object",
    "properties": {
      "content": { "type": "string", "description": "要记住的内容，一句话，不超过 200 字" },
      "type": { "type": "string", "enum": ["strategy", "fact", "trait", "cognition"],
                "description": "strategy=规则/做法，fact=事实，trait=偏好，cognition=原则" },
      "importance": { "type": "number", "description": "1-10，默认 7" }
    },
    "required": ["content"]
  },
  "output": {
    "schema": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "ok": { "type": "boolean" },
        "id": { "type": "string" },
        "duplicate": { "type": "boolean" },
        "reason": { "type": "string" }
      },
      "required": ["ok"]
    }
  }
}
```

行为：

1. 走与 `observe` 相同的写入闸门（`gateDrafts`）：类型、长度、语义
2. 按内容精确去重：已存在则返回 `{ok:true, duplicate:true}`，不重复写
3. 通过后 `store.put`，返回新 id
4. 闸门拒绝返回 `{ok:false, reason}`

**不暴露** `forget` / `supersede`：删除与取代仍是人的操作（RFC 0004 的结论）。

## 3. 实现位置

全部在插件（`dsh-plugin-soulbridge`），core 不改：

- `apply()` 里新增 `try { ctx.inject(['tools'], ...) } catch {}`
- 工具执行体调用已有的 `ensureSoul()` 与 core API
- 日志：`tools registered (soul_recall, soul_remember)`，失败记 `tools registration failed: ...`

## 4. 验证

| 项 | 方式 |
|---|---|
| 注册与注销 | 日志出现 `tools registered`；重载后不重复 |
| recall 计入召回 | 单测（core 已有路径）+ 手工调用后看 `recallCount` |
| remember 过闸门 | 单测：超长/纯标点返回 `ok:false` |
| remember 去重 | 单测：同内容二次返回 `duplicate:true` |
| 库不可用 | 单测：返回 `ok:false` 不抛 |
| 真实可用 | 会话里问"之前说过什么"，观察是否调用 |

## 5. 何时可以实施

- 现在。无 schema 变更、无新依赖、不影响既有注入路径
- 风险：工具描述写不好会导致模型滥用（频繁查/频繁记）——通过描述和一次真实会话调优

## 6. 遗留

- 工具调用是否影响 `by=llm` 的统计口径（模型写的记忆来源标 `tool`，需要 `extractedBy` 扩展）
- `soul_remember` 的 `importance` 默认值需要观察后再定
