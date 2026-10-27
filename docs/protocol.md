# 协议：四个动词

宿主只需要在四个时机调用。**这四个动词就是全部 API 面。**

v0 通过 CLI/stdio 调用；v1 暴露为 MCP server（工具名一一对应）。

---

## 1. `context` — 会话开始

**输入**

```json
{
  "soulId": "xiaoling",
  "userId": "exzhuyo",
  "query": "用户开场的第一句话（可选）",
  "maxChars": 1200
}
```

**输出**

```json
{
  "text": "<soul>...</soul><profile>...</profile><memories>...</memories><style>...</style>",
  "used": ["mem_01", "mem_07"],
  "dropped": 12,
  "chars": 846
}
```

**约定**

- 总长度受 `maxChars` 硬约束，超出按分数丢弃，**绝不截断半句话**
- `text` 必须是可直接拼进 system prompt 的纯文本，不含任何宿主特定语法
- 每条被注入的记忆都要出现在 `used` 里——**没有 `used` 的注入不可审计**

## 2. `observe` — 每轮结束

**输入**

```json
{
  "soulId": "xiaoling",
  "userId": "exzhuyo",
  "turn": { "role": "user", "content": "以后提交前先跑测试", "at": "2026-10-27T22:00:00Z" }
}
```

**输出**：`{ "written": 1, "emotionDelta": { "tension": 0 } }`

**约定**

- 必须廉价（同步、无 LLM、<5ms）
- 只做规则命中（"记住/我喜欢/以后/决定"）与情绪微调
- 写失败不影响宿主会话——**永远不抛给宿主**

## 3. `recall` — 需要时

**输入**

```json
{ "soulId": "xiaoling", "userId": "exzhuyo", "q": "测试", "limit": 5 }
```

**输出**

```json
{ "memories": [ { "id": "mem_07", "type": "strategy", "content": "...", "score": 0.81 } ] }
```

**约定**

- 调用即 `recallCount++`、`lastRecalledAt=now`（这是"唤醒"的语义）
- 默认只返回 `status=active` 且 `visibility` 允许的条目
- 返回 `id`，让宿主可以引用

## 4. `reflect` — 会话结束

**输入**

```json
{
  "soulId": "xiaoling",
  "userId": "exzhuyo",
  "turns": [ { "role": "user", "content": "..." }, { "role": "assistant", "content": "..." } ],
  "llm": "optional"        // 未提供时走规则抽取
}
```

**输出**

```json
{ "memories": 3, "superseded": 1, "emotion": { "tension": 0.2, "bond": 0.4 } }
```

**约定**

- LLM 由外部注入（`(prompt) => string`），`core` 不认识任何模型
- 没有 LLM 时降级为规则抽取——**降级是能力的一部分，不是错误**
- 反思结果 `importance` 默认 6.0（高于普通事实的 4.0）

---

## 失败与降级

| 情况 | 行为 |
|---|---|
| 数据库不可用 | 返回空 `context`，宿主照常工作，写一条 stderr 警告 |
| 注入超预算 | 按分数丢弃，返回真实 `dropped` 数 |
| `reflect` 的 LLM 超时 | 降级规则抽取，不阻塞会话结束 |
| 未知 `soulId` | 自动创建（需注册策略，见下） |

**总原则：永远不阻塞宿主。** 人格层是增强，不是依赖。

## MCP 映射（v1）

| 动词 | MCP tool |
|---|---|
| `context` | `soul_context` |
| `recall` | `soul_recall` |
| `observe` | `soul_observe` |
| `reflect` | `soul_reflect` |

MCP 是跨宿主的兜底通道：**当某个宿主的 hooks 不稳定时，至少工具还能用。**
