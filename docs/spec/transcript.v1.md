# spec/transcript.v1 — 可移植会话转写

- 关联：ADR 0023
- 用途：`soulbridge ingest --file transcript.jsonl`

## 格式

JSONL，每行一个对象。**只需要两种信息**：谁说的、说了什么。

```jsonl
{"role":"user","content":"以后提交前先跑 make check","at":1761600000000}
{"role":"assistant","content":"好，记住了。"}
```

`at` 可选（epoch ms）；缺省时 ingest 用当前时间。

## 解析器接受的形态（按顺序匹配）

| 形态 | 例子 |
|---|---|
| 标准 | `{"role":"user","content":"…"}` |
| 别名词 | `{"type":"assistant","text":"…"}` |
| 嵌套消息 | `{"message":{"role":"user","content":"…"}}` |
| 数组内容 | `{"role":"user","content":[{"type":"text","text":"…"}]}` |

角色别名：`user|human` → user；`assistant|ai|model` → assistant。

## 必须跳过的

| 行 | 原因 |
|---|---|
| `{"type":"header",…}` | 元数据 |
| `role: tool` / `tool_result` | 工具输出，隐私与噪音 |
| `thinking` / `reasoning` | 推理片段 |
| 无法解析的 JSON | 容错 |

被跳过的行计入响应的 `skipped` 字段。

## 约束

- 连续相同（role + content）的行合并
- 单条内容上限 20,000 字符（超出截断）
- 最多 5,000 轮
- 空内容跳过

## 响应

```json
{ "ok": true, "turns": 12, "skipped": 3, "reflected": { "memories": 2, "superseded": 0, "emotion": { } }, "dryRun": false }
```

`--dry-run` 只解析与计数，不写库。

## 隐私

- ingest 只把 `user` 轮次送进情感分析（`analyze`），模型分析器默认关闭
- 反思只保存抽取后的记忆，不保存原文
- 转写文件由宿主/用户提供，`soulbridge` 不主动扫描任何目录
