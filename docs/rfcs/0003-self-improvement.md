# RFC 0003：自我改进环路（证据 → 策略）

- 状态：Proposed（A 阶段实施中）
- 日期：2026-10-29
- 关联：ADR 0018（成长可证伪）、ADR 0025（模型能力注入）

---

## 1. 问题

系统只从**用户回合**抽取记忆。我的回复、我意识到的错误，没有任何通路进入记忆。

结果：同一个错误（例如"用截断糊弄问题"）在第一次被指出后，下次仍然会犯——它只存在于那次对话里。

这直接削弱 ADR 0018 的主指标 `repeatCorrection`：如果连"我犯过什么错"都没记下来，
复发率就无法归因。

## 2. 不做什么

**不直接从我的回复里抽策略。** 理由：

- 自我评价不是证据（"我应该更严谨"是表态，不是事实）
- 会自我强化：模型把自己的猜测写成策略，之后每次提醒自己，越错越自信

## 3. A 阶段：只收集证据（本次实施）

### 3.1 什么算证据

| 证据 | 判定 | 可信度 |
|---|---|---|
| 用户明确纠正 | 命中 `CORRECTION` 正则（不对/错了/不是这样…） | 高 |
| 命令失败 | 未来：工具结果 `finish: error` | 中 |
| 重试成功 | 未来：同一目标第二次尝试才成功 | 中 |
| 自我表态 | **一律不采集** | 无 |

A 阶段只做第一行（用户纠正）。

### 3.2 存在哪里

**独立表 `corrections`，不进 `memories`。** 理由：

- 证据和记忆的用途不同：证据用于日后提炼，记忆用于注入
- `memories` 会被注入（`strategy|fact|trait`），证据不应出现在 prompt 里
- 混合存储会让 `list` 与注入过滤都变复杂

```sql
CREATE TABLE corrections (
  id          TEXT PRIMARY KEY,
  soul_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  at          INTEGER NOT NULL,
  user_text   TEXT NOT NULL,      -- 用户原话，完整
  assistant_text TEXT,            -- 我当时说的那段，完整（可空）
  rule        TEXT,               -- 命中词，便于统计
  device_id   TEXT
);
CREATE INDEX idx_corrections ON corrections(soul_id, user_id, at DESC);
```

**不截断**：两段文本完整保存。容量问题由保留期（默认 90 天）解决，而不是切内容。

### 3.3 采集路径

插件在会话里已经能看到两类事件：

- `assistant/message` → 缓存最近一条我的回复文本
- `user/message` → 若命中纠正正则，写入一条 correction（带缓存的回复）

core 提供 `Soul.recordCorrection({ userText, assistantText, rule })`，不做判定（判定在插件，
因为需要"上一条回复"这种会话状态）。

### 3.4 验收

| 项 | 标准 |
|---|---|
| 表与迁移 | schema v3，旧库升级后 `corrections` 存在 |
| 记录 | 用户说"不对，截断是粗暴的"→ 新增 1 条，含我的上一段回复 |
| 不影响注入 | `context()` 输出里不出现 corrections 内容 |
| 可查看 | `soulbridge corrections` 列出最近 N 条 |
| 可统计 | `soulbridge status` 显示纠正条数 |

## 4. B 阶段：提炼（暂不实施）

### 4.1 前提

A 阶段积累 ≥ 20 条带上下文的纠正，才值得动手。

### 4.2 做法

会话结束（或每 N 条 correction）时，把「我的回复 + 用户纠正」交给模型：

```
输入：assistant_text、user_text
输出：{"type":"cognition","text":"≤40 字的可执行策略"} 或 null
```

### 4.3 四条护栏

1. **只从证据出发**：prompt 明确"这是用户纠正"，不允许自由联想
2. **标注来源**：`source: 'self'`，与用户策略区分
3. **权重更低**：`importance 5`（用户策略 7），注入时排后面
4. **可撤销可测量**：`list` 可见来源、`forget` 可删；对照 `repeatCorrection`

### 4.4 可证伪实验

> 开启 B 前后各两周，比较同一类纠正的复发率。
> 若复发率无下降，说明提炼出的策略无效 → 关闭 B，保留 A 的证据池。

## 5. 与现有 DSH 记忆插件的对比

以下基于 npm 元数据与仓库描述，**未逐行读代码**，只作为定位参考。

| 项目 | 定位 | 检索 | 学习机制 | 与我们的差异 |
|---|---|---|---|---|
| [`dsh-memory`](https://www.npmjs.com/package/dsh-memory) 0.1.0 | 跨会话持久记忆：SQLite FTS5 + 3 个模型工具 + 召回提示段 | FTS5 全文 | 由模型主动调用工具写入 | 工具驱动（依赖模型自觉）；我们是指令抽取驱动 |
| [`@furongjun1999/dsh-memory`](https://www.npmjs.com/package/@furongjun1999/dsh-memory)（灵枢 0.9.16） | 平台级：md 认知图 + Rust 检索 + 蜂群 + 编译器 | md 文件即真源，索引为派生 | **确定性规则裁决，零 LLM 判断**；元认知按条件路由，不确定标 BLINDSPOT | 体量 1813 文件 / 27.5MB，需 Python（+Rust 编译）；接口是 **MCP**，五端通用 |
| [`@lmzhen/dsh-memory`](https://www.npmjs.com/package/@lmzhen/dsh-memory) | 自演化的记忆 provider 注册表 | provider 可插拔 | 社区构建的演化流程 | 偏框架；我们是单一实现 + 明确实验 |
| [kovey/dsh-memory](https://github.com/kovey/dsh-memory) | 分层记忆：项目/全局严格分离，任务前召回、任务后持续学习 | 分层 | 任务后学习 | 它的"持续学习"偏任务结果；我们的学习要经纠正证据 |

**我们的差异点（要守住）**：

1. **情绪层**：其他插件基本不做"用户当下情绪 + 自身情绪"的建模
2. **可证伪**：每个机制都配实验和指标（affect 有黄金集、成长有 `repeatCorrection`）
3. **宿主无关**：core 零依赖，DSH 只是第一个适配器

**要承认的差距**：

1. 它们大多已经发布、有下载量、有 UI 管理页；我们只有 CLI
2. FTS5 检索比我们的关键词评分更成熟
3. 它们的"学习"已经跑在真实用户上，我们还在验证阶段

## 6. 开放问题

1. 纠正的判定是否应该包含"用户重复同一要求"（不说"不对"，但再次提出）？
2. 证据保留期 90 天是否合理？需要按数据量调整吗？
3. B 阶段的模型调用应该按条触发还是按会话触发？
4. 是否要把 corrections 暴露给用户编辑（删除误判的纠正）？

## 7. 从灵枢（FuRongJun-1999/dsh-memory）学到的四条

依据：其 README 与 npm 元数据（0.9.16），未读源码。

### 7.1 接口用 MCP，而不是"每个宿主写一个适配器"

灵枢把能力做成 stdio MCP server，DSH / CodeBuddy / ZCode / Codex CLI / Claude Code
挂同一个 server，差异只在"纪律怎么注入"。这比我们 ADR 0024 的"一宿主一包"更省。

**对我们的含义**：`soulbridge` 可以再出一个 MCP 适配器，一次覆盖多宿主；
DSH 插件保留是因为它能拿到 `session/event`（MCP 拿不到自动观察）。

### 7.2 写入要"确定性裁决 + 显式 committed"

灵枢明确"记什么、取什么、能不能写入全部由确定性规则裁决"，写入过三道闸门并以
`committed` 确认，**绝不假装成功**。

我们的 `observe` 返回 `written` 计数，但没有"提交确认"语义；Phase B 引入模型后，
这一点更重要——**模型产出的东西必须有独立的提交判据**，不能因为调用成功就认为写入成立。

### 7.3 分层写入闸门：越靠近"自我"，越需要外部裁定

灵枢按层收紧：`contextual` 可直写 → `knowledge` 需反思单元 → `structural` 需反思+验证 →
`self`/`anchor` **需人工裁定**。

这正好回答我们 Phase B 的护栏问题：自我蒸馏出的策略属于 `self` 层，**不应该自动生效**。
修订：B 阶段产出的策略先进 `pending` 状态，由用户确认后才进入注入（`soulbridge approve`）。

### 7.4 长会话提醒：每 10 个真实用户回合

它按"真实用户回合"计数（不是 system prompt 组装次数）提醒归档。我们目前没有任何
会话长度的感知，长会话里记忆会被越冲越淡。

## 8. 修订后的 B 阶段设计（相对第 4 节）

1. 采集（A 阶段）不变；
2. 达到 20 条纠正后，提炼产出 `cognition` 草稿，状态 `pending`；
3. `soulbridge review` 逐条确认/拒绝；确认后才 `active` 并参与注入；
4. 指标仍是 `repeatCorrection`，对照组是"不提炼"。

这样即使模型提炼错了，也不会自动污染注入——**错误停在待审区**。