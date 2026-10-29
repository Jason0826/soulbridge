# protocol.v0 — 四个动词的契约

- 版本：`0.3`（2026-10-29：写入闸门与 `committed`；`superseded` 改为诚实上报；模型边界见 ADR 0025）
- 状态：Accepted（2026-10-27，0.2 于 2026-10-28）
- 关联：ADR 0005（版本策略）、ADR 0007（接入阶梯）、ADR 0012（affect 范围）

本文件是**测试的依据**：每个字段、每个错误码、每条降级都应有对应测试。

---

## 0. 通用约定

### 0.1 传输

v0 没有网络协议。同一份契约有三种落地方式，语义必须一致：

| 形态 | 调用方式 |
|---|---|
| CLI | `soulbridge context --query "..."` 等子命令，stdout 输出 JSON |
| 进程内 | `Soul.context()` / `.observe()` / `.recall()` / `.reflect()` |
| 未来 MCP | 工具名 `soul_context` / `soul_observe` / `soul_recall` / `soul_reflect` |

### 0.2 信封

所有请求隐含 `protocolVersion`（v0 固定 `"0.1"`）。响应顶层必须包含：

```json
{ "ok": true, "data": { }, "error": null }
```

失败时：

```json
{ "ok": false, "data": null, "error": { "code": "DB_UNAVAILABLE", "message": "…" } }
```

### 0.3 错误码（固定枚举，不允许临时新增）

| code | 含义 | 调用方应做 |
|---|---|---|
| `BAD_REQUEST` | 参数缺失或类型错误 | 修正调用，不重试 |
| `DB_UNAVAILABLE` | 存储不可用 | 降级，继续会话 |
| `BUDGET_EXCEEDED` | 输入超出硬上限 | 截断输入后重试一次 |
| `UNKNOWN_SOUL` | soulId 不存在且禁止自动创建 | 先 init |
| `INTERNAL` | 未分类异常 | 记录，降级 |

**约束**：`observe` / `reflect` 面向宿主的调用**永不抛出**，一律返回 `ok:false` + 错误码。只有进程内 API 的内部错误可以抛，且必须带 `code`。

### 0.4 版本规则（ADR 0005）

- 加字段 → MINOR 升级，旧实现必须忽略未知字段
- 删字段 / 改语义 / 改默认值 → MAJOR 升级
- 响应中的 `protocolVersion` 必须回显，便于 adapter 判断兼容

---

## 1. `context` — 会话开始

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `soulId` | string | 是 | 灵魂标识 |
| `userId` | string | 是 | 用户标识（本地默认 `local`） |
| `query` | string | 否 | 用户开场第一句；提供时启用相关性筛选 |
| `maxChars` | number | 否 | 默认 1200，硬上限 8000 |

### 响应 `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 可直接拼进系统提示的纯文本 |
| `used` | string[] | 被注入的记忆 id，顺序与 `text` 中一致 |
| `dropped` | number | 因预算被丢弃的条数 |
| `chars` | number | `text` 的实际长度 |

### 不变量（必须测试）

1. `chars === text.length`，且 `chars <= maxChars`
2. `text` 中不存在截断标记（`…`、`[truncated]`）——要么完整，要么不出现
3. `used` 中每个 id 都能在存储中查到，且注入后 `recallCount` 各 +1
4. `query` 为空时按权重排序；非空时零相关记忆不出现

### 示例

```json
{
  "ok": true,
  "data": {
    "text": "<soul name=\"小灵\">\n你是小灵，一个持续成长的伙伴。你已经和用户相处了 3 天。\n</soul>\n\n<memories>\n- [strategy] 以后提交前先跑 make check\n</memories>",
    "used": ["mem_abc123"],
    "dropped": 2,
    "chars": 118
  },
  "error": null
}
```

---

## 2. `observe` — 每轮结束

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `soulId` | string | 是 | |
| `userId` | string | 是 | |
| `turn.role` | `"user"` \| `"assistant"` | 是 | 只分析 `user` |
| `turn.content` | string | 是 | 单条消息，> 32KB 时返回 `BUDGET_EXCEEDED` |
| `turn.at` | number | 否 | epoch ms，默认当前时间 |

### 响应 `data`

```json
{
  "written": 1,`n  "committed": true,`n  "rejections": [],
  "emotion": { "passion": 0.3, "bond": 0.32, "tension": 0.1, "selfRegard": 0.3, "curiosity": 0.3, "contentment": 0.3 },
  "affect": {
    "analyzer": "lexicon",
    "hits": [{ "term": "难过", "category": "sadness", "intensity": 7, "polarity": "negative", "negated": false, "position": 1 }],
    "dominant": "sadness",
    "intensity": 7,
    "valence": -1,
    "arousal": 0.78,
    "features": { "fillers": 0, "hedges": 0, "vague": 0, "tokens": 12, "density": 1 },
    "confidence": 0.67,
    "abstain": false
  }
}
```

`affect` 在 0.2 中是**新增可选字段**：旧 adapter 忽略即可。assistant 消息返回空信号（`analyzer: "none"`）。

### 约束

1. 规则路径同步、无模型调用；注入 `llm` 时可能调用模型（ADR 0025），此时不保证 5ms
2. 永不抛异常；存储失败返回 `DB_UNAVAILABLE` 且 `written: 0`
3. 同一内容重复提交不产生重复记忆（按内容去重）
4. v0 **不修改** 由 `reflect` 维护的任何策略/认知条目
5. **`affect` 不得影响 `emotion`**：同一 turn 在任意分析器下，`emotion` 必须逐位相同（T10）
6. `observe` 在 0.2 中是异步的（可能调用模型）；调用方必须能接受 Promise

---

## 3. `recall` — 按需召回

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `soulId` / `userId` | string | 是 | |
| `q` | string | 是 | 查询词，空字符串返回 `BAD_REQUEST` |
| `limit` | number | 否 | 默认 5，上限 50 |

### 响应 `data`

```json
{ "memories": [ { "id": "mem_abc", "type": "strategy", "content": "…", "score": 0.81 } ] }
```

### 约束

1. 只返回 `status = active` 且可见性允许的条目
2. 每次召回使命中条目 `recallCount + 1`、`lastRecalledAt = now`
3. 结果按 `score` 降序，`score` ∈ [0, 1]

---

## 4. `reflect` — 会话结束

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `soulId` / `userId` | string | 是 | |
| `turns` | Turn[] | 是 | 按 ADR 0008 过滤后的会话（仅 user + assistant 最终回复） |
| `llm` | boolean | 否 | v0 固定 `false`；为 `true` 时返回 `BAD_REQUEST`（尚未实现） |

### 响应 `data`

```json
{ "memories": 2, "superseded": null, "committed": true, "rejections": [], "emotion": { } }
```

### 约束

1. 无模型可用时必须完成（规则抽取），不得返回"失败"
2. 相同 `turns` 重复调用不产生重复记忆（幂等）
3. 高唤醒事件（后由 affect 提供，v0 无）才提升 `importance`

---

## 5. 降级矩阵（必须逐条测试）

| 场景 | 期望行为 |
|---|---|
| 数据库文件被删除 | `context` 返回空 `text` + `ok:true`（`used:[]`），并写 stderr |
| 数据库被锁 | 返回 `DB_UNAVAILABLE`，宿主继续 |
| `maxChars` 极小（如 50） | 只保留 `<soul>` 段，`used:[]`，不报错 |
| 输入含未闭合 XML/超长行 | 正常处理，不崩溃 |
| 未知 `soulId` | 自动创建（`init` 语义），并在响应中不报错 |
| 未来出现未知字段 | 忽略，不报错 |

---

## 6. 测试映射

| 契约条款 | 测试名约定 |
|---|---|
| 0.3 错误码 | `protocol:error-codes` |
| 1.x 不变量 | `protocol:context-invariants` |
| 2.x 约束 | `protocol:observe-idempotent` |
| 3.x 约束 | `protocol:recall-touch` |
| 4.x 约束 | `protocol:reflect-idempotent` |
| 5 降级 | `protocol:degrade-*`（每条一个） |

测试未覆盖的条款，视为未生效。

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1 | 2026-10-27 | 四动词初版 |
| 0.2 | 2026-10-28 | observe 增加可选 affect 字段；observe 改为异步；新增「affect 不影响 emotion」约束 |
| 0.3 | 2026-10-29 | observe 增加 committed / rejections（写入闸门）；reflect 的 superseded 改为 null（未实现不得报 0）；明确模型可选边界 |
