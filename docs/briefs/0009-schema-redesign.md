# 需求说明：schema 重设计（从消费者反推字段）

- 状态：Draft
- 日期：2026-10-30
- 后续：`spec/storage.v0.md`、ADR 0003（存储）、ADR 0021（同步）、`briefs/0006` `0007` `0008`
- 审计脚本：`scripts/field-audit.mjs`（只读，出表即本文件 §2 的数据）

---

## 1. 一句话目的

把 soulkernel 留下的字段（多人共养、知识图谱时代的产物）和"从没被写过"的字段清出去，让每一列都回答得出：**谁写它、谁读它、它决定了什么**。

## 2. 现状：审计结果（2026-10-30，35 条记忆）

| 字段 | 真机分布 | 判定 |
|---|---|---|
| `visibility` | 35/35 = `private` | **常量，死的**。写入恒为 private，查询里的 `OR visibility='shared'` 是死分支 |
| `status` | 35/35 = `active` | 常量；`archived` 零写入零过滤 |
| `valid_until` | 35/35 = NULL | 有过滤消费者，但**没有任何写入路径**产生它 |
| `superseded_by` | 35/35 = NULL | 同上；`supersede()` 无业务调用者 |
| `valid_from` | 有值 | 只写不读，与 `created_at` 重复 |
| `vividness` | 只有 0.8 / 0.9 | 创建时定值，之后永不变化 |
| `creator`（souls） | NULL | 无写入 |
| `recall_count` | 0/1/3/4 | 有分布，在用 |
| `deleted_at` | 31 NULL + 4 墓碑 | 在用（forget 会写） |

类型枚举的引用数（静态）：`semantic` 3 · `episodic` 1 · `relationship` 2 · `archived` 1 · `shared` 3。
`EXTRACTABLE_TYPES` 只允许 `strategy / trait / fact / cognition`，所以另外三个**不可能被产生**。

## 3. 消费者与决定

| 消费者 | 什么时候 | 要做什么决定 | 需要哪几列 |
|---|---|---|---|
| `context()` | 每轮 | 这 ≤5 条注入哪些 | content, type, keywords, valid_until, superseded_by, evidence, importance |
| `observe()` | 每轮 | 这条值不值得记、算几等证据 | type, content, importance, evidence, device_id |
| `recall()` | 工具调用 | 取哪几条、记账 | id, content, recall_count, last_recalled_at |
| `corrections` | 每轮 | 是不是纠正、指向哪次回答 | user_text, assistant_text, layer, signal, confidence |
| 评估（0005 / 0018） | 阶段前后 | 同类错误有没有减少 | corrections + 记忆的 supersede 链 |
| 同步（ADR 0021） | 跨设备 | 以谁为准 | updated_at, device_id, deleted_at |
| 审计（N2，未做） | 事后 | 这条是谁、为什么写的 | evidence, rule/marker, created_at |

## 4. 新 schema（提案）

### 4.1 `memories`

| 列 | 类型 | 谁写 | 谁读 / 决定什么 | 变更 |
|---|---|---|---|---|
| `id` | TEXT PK | observe/remember | 引用 | 保留 |
| `soul_id` `user_id` | TEXT | 同上 | 隔离 | 保留 |
| `type` | TEXT | 抽取器 | 注入筛选 | **删 `semantic` `relationship`**；保留 `episodic`（B1 要用）|
| `content` | TEXT | 同上 | 注入正文 | 保留 |
| `keywords` | TEXT(JSON) | 同上 | 相关性打分 | 保留 |
| `importance` | INTEGER 1–10 | 同上 | 预算内排序 | 保留，定义改为"值不值得占注入位" |
| `evidence` | TEXT | 写入路径 | 排序权重、审计 | **新增**：`correction / user / rule / llm` |
| `source_ref` | TEXT | 写入路径 | 回溯（N2） | **新增**，可空 |
| `recall_count` | INTEGER | `recall()` | 衰减派生 | 保留 |
| `last_recalled_at` | INTEGER | `recall()` | 衰减派生 | 保留 |
| `valid_until` | INTEGER | 抽取器（临时事实） | 注入时过滤 | 保留；**必须有写入路径**，否则删 |
| `superseded_by` | TEXT | 冲突判定 | 注入时过滤 | 保留；**必须自动写**，否则删 |
| `created_at` `updated_at` | INTEGER | 写入路径 | 时效、同步 | 保留 |
| `deleted_at` | INTEGER | forget | 墓碑 | 保留 |
| `device_id` | TEXT | 写入路径 | 同步 | 保留 |
| `visibility` | — | — | — | **删** |
| `vividness` | — | — | — | **删** |
| `valid_from` | — | — | — | **删**（与 created_at 重复）|
| `status` | — | — | 只剩 active/superseded | 保留，**删 `archived`** |

### 4.2 `corrections`

| 列 | 谁写 | 谁读 | 说明 |
|---|---|---|---|
| `id` `soul_id` `user_id` `at` `device_id` | 记录路径 | 审计 | 保留 |
| `user_text` `assistant_text` | 同上 | 提炼、评估 | 保留 |
| `layer` | 检测器 | 统计 | **新增**：`rule / structural / llm` |
| `signal` | 检测器 | 调参 | **新增**：`explicit / negation / replacement / meta` |
| `confidence` | 检测器 | 阈值 | **新增**：0–1 |
| `target_memory_id` | 检测器（能定位时） | repeatCorrection 分子 | **新增**，可空 |
| `marker` | 检测器 | 解释"为什么记" | 原 `rule` 列改名 |

### 4.3 `emotions`

| 列 | 变更 |
|---|---|
| 六维 | 保留（0006 再决定是否映射 PAD）|
| `updated_at` | 保留 |
| 语义 | **写进 spec**：按轮还是按会话更新，二者只能选一个 |

### 4.4 `affect_samples`

保留现状。`payload` 不含原文这一条继续守住（隐私底线）。

## 5. 需求

| 级别 | 需求 | 验收 |
|---|---|---|
| **必须** | 每一列都写得出"谁写、谁读、决定什么" | 本文件 §4 的表格必须无空格 |
| **必须** | 没有任何列在真机上是"全 NULL 且无写入路径" | `field-audit` 输出无此项 |
| **必须** | 迁移可回滚，迁移前后 `PRAGMA integrity_check` 通过 | 迁移测试 |
| **应该** | `valid_until` / `superseded_by` 要么有写入路径，要么删掉 | 二选一并落地 |
| **不做** | 新增召回事件表（recalls） | 先用 count + 时间近似 |

## 6. 迁移策略

1. `schema_version` 3 → 4；只加列/删列，不改已有列语义
2. 删列在 SQLite 需要重建表：新建 → 拷贝 → 改名 → 校验行数
3. 旧数据里的 `visibility='private'`、`vividness` 直接丢弃（它们没有信息量）
4. 回滚脚本必须存在，且演练一次

## 7. 成功判据（可执行）

```
node scripts/field-audit.mjs        → 无"全 NULL（无写入）"、无"常量（无区分度）"
迁移测试                            → 行数不变、integrity_check ok、回滚后 schema_version=3
context() 测试                      → 注入仍 ≤5 条，`used` 可追
```

## 8. 前置条件与时机

- **什么时候可以实施**：S1 收尾后（schema 变更是范围外）。
- **依赖**：先补 `evidence` 的写入路径（0007），否则新列一上来就是 "全 NULL"。
- **什么情况下不做**：如果 `repeatCorrection` 在两周内拿不到任何数据，说明纠正闭环整体还没到设计 schema 的时候。

## 9. 开放问题

1. `emotions` 六维保留还是映射到 PAD 三维？（0006）
2. `episodic` 保留是对的，但 `semantic` 删掉后，知识型事实和 `fact` 有什么区别？需要一句话定义。
3. `valid_until` 的写入路径由谁产生：抽取器能判断"这条会过期"吗？判断不了就删列。
4. `target_memory_id` 怎么定位：需要把"上一轮回答"映射到"当时注入的记忆"，`context().used` 已经有 id 列表。
5. 删列会让协议版本变化（`spec/protocol.v0.md`），是否需要 v1？
