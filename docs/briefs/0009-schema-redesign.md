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
| `type` | TEXT | 抽取器 | 注入筛选 | **删 `relationship`**；`episodic` 保留（B1）；`semantic` 保留，边界见 §4.1.1 |
| `content` | TEXT | 同上 | 注入正文 | 保留 |
| `keywords` | TEXT(JSON) | 同上 | 相关性打分 | 保留 |
| `importance` | INTEGER 1–10 | 同上 | 预算内排序 | 保留，定义改为"值不值得占注入位" |
| `evidence` | TEXT | 写入路径 | 排序权重、审计 | **新增**：`correction / user / rule / llm` |
| `source_ref` | TEXT | 写入路径 | 回溯（N2） | **新增**，可空 |
| `recall_count` | INTEGER | `recall()` | 衰减派生 | 保留 |
| `last_recalled_at` | INTEGER | `recall()` | 衰减派生 | 保留 |
| `valid_from` | INTEGER | 抽取器（事实成立时间） | 点查"当时是什么" | 保留，见 §4.1.2 |
| `valid_until` | INTEGER | 取代路径（旧事实终结时间） | 注入时过滤"已不成立" | 保留，见 §4.1.2 |
| `superseded_by` | TEXT | 冲突判定 | 注入时过滤 | 保留；**必须自动写**，否则删 |
| `created_at` `updated_at` | INTEGER | 写入路径 | 时效、同步 | 保留 |
| `deleted_at` | INTEGER | forget | 墓碑 | 保留 |
| `device_id` | TEXT | 写入路径 | 同步 | 保留 |
| `visibility` | — | — | — | **删** |
| `vividness` | — | — | — | **删** |
| `status` | — | — | 只剩 active/superseded | 保留，**删 `archived`** |

### 4.1.1 记忆类型边界（一句话定义 + 判定顺序）

| 类型 | 一句话 | 例子 | 带时间标签 |
|---|---|---|---|
| `strategy` | 该怎么做 | 改动前先解释为什么、怎么做、什么影响 | 否 |
| `trait` | 他是什么样的人 | 我习惯做事严谨 | 否 |
| `cognition` | 他认为什么更重要 | 思想比落地更宝贵 | 否 |
| `semantic` | 可复用的抽象结论 | 记忆不是容量，是人格 | 否 |
| `fact` | 具体的值或配置 | 发布窗口是每周三 | 否 |
| `episodic` | 某天发生过什么 | 昨天我们把 S1 扩了一个口子 | **是** |

判定顺序（一条内容同时像多类时，取第一个成立的）：

1. 能改写成"遇到 X 就该做 Y" → `strategy`
2. 能改写成"他倾向于 / 习惯 Z" → `trait`
3. 能改写成"他认为 A 比 B 重要" → `cognition`
4. 能离开具体场景独立复用的结论 → `semantic`
5. 只能是某个具体的值 / 配置 → `fact`
6. 必须带时间才有意义 → `episodic`

**`semantic` 与 `fact` 的差别只有一个：抽象层级**（结论 vs 具体值）。目前过滤时不区分二者，所以这条差别还没有消费者差异——保留它是为了 B1 / 提炼阶段区分"从经历里长出来的结论"。**到 S2 仍无消费者就删。**

`relationship` 删除：它是"几个人共养"模型的产物（谁和谁的关系），soulbridge 单用户，无消费者。

### 4.1.2 时效区间：`valid_from` / `valid_until`

它们不是"到期自动删除"，是**记录事实成立的时间区间**。

例：

```
2020 年加入爱立信      → 记忆 A：valid_from = 2020-xx
2026 年离职            → 记忆 A：valid_until = 离职时间，superseded_by = 记忆 B
                        记忆 B：内容是"已离开爱立信 / 现就职于 X"
```

由此三条：

1. **`valid_from` ≠ `created_at`**。前者是"事实何时开始成立"，后者是"这条何时被写进来"——上例里 valid_from 是 2020，created_at 是 2026 年这次对话。**二者不能合并**（我上一版建议删 `valid_from` 是错的，纠正于此）。
2. **`valid_until` 的写者是"取代路径"，不是"抽取器判断这条会不会过期"**。它由新事件终结旧事实时写入，时间取新事件里的表达（"上个月离职" → 上个月）；提取不到才退化为 `now`。
3. **`superseded_by` 与 `valid_until` 是同一次动作的两个视角**：被谁取代 / 何时不再成立。必须同写，否则又会出现"一个写了另一个没写"。

前置能力：抽取器要能识别时间表达（"2020 年"、"上个月"、"现在"）。做不到的话这两列会退化成死列——**那就先别加**，而不是加了再等。

```
验收
  写入"我在爱立信工作"        → valid_from 有值
  写入"我上个月离职了"        → 旧记忆 valid_until ≈ 上月，superseded_by 指向新记忆
  注入时                      → 旧记忆不再出现
  点查"我 2021 年在哪工作"    → 能命中旧记忆（区间查询，本阶段不做）
```

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

**决定（2026-10-30）：保留六维，不映射到 PAD 三维。**

理由：六维是从文献（OCC / EMA / 情感动力学）结合本产品需求定出来的，它对应的是我们要做出的行为差异（谨慎度、主动性、语气），而不是心理学界的标准坐标。映射到 PAD 会丢掉 `bond` / `selfRegard` 这类直接影响表达的维度。

代价，写在这里防止以后忘了：**无法和 Sentipolis 那类 PAD 工作的数字横向对比**，只能自比（前后对比、三臂对比）。ADR 0017 的判据本来就是自比，所以不冲突。

| 列 | 变更 |
|---|---|
| 六维（passion / bond / tension / selfRegard / curiosity / contentment） | 保留 |
| `updated_at` | 保留 |
| 语义 | **写进 spec**：按轮还是按会话更新，二者只能选一个（见 0006）|

### 4.4 `affect_samples`

保留现状。`payload` 不含原文这一条继续守住（隐私底线）。

### 4.5 字段说明（每列一句话）

**规则：新增一个字段，必须同时给出这一句；写不出就是没想清楚。** 实施时这段原样搬进 `spec/storage.v0.md`。

#### `memories`

| 列 | 一句话 |
|---|---|
| `id` | 记忆的唯一标识，`mem_<时间前缀>_<随机>` |
| `soul_id` | 这条记忆属于哪个灵魂 |
| `user_id` | 谁的经历/事实；单用户时恒为 `local` |
| `type` | 记忆分型，决定它怎么被使用（见 §4.1.1）|
| `content` | 记忆正文，一句话陈述，也是注入时展示的唯一内容 |
| `keywords` | 内容的中文 bigram + 英文词，用于词面相关性；可从 content 重建 |
| `importance` | 1–10，值不值得占一个注入位 |
| `evidence` | 证据来源：`correction` / `user` / `rule` / `llm`（新增）|
| `source_ref` | 指回产生它的对话或纠正，用于审计（新增）|
| `recall_count` | 被 `recall()` 命中的累计次数 |
| `last_recalled_at` | 最近一次被召回的时间，供衰减派生使用 |
| `valid_from` | 事实**开始成立**的时间，可能远早于写入时间 |
| `valid_until` | 事实**不再成立**的时间，由取代路径写入 |
| `superseded_by` | 取代它的新记忆 id；与 `valid_until` 同一次写入 |
| `created_at` | 这条何时被写进库 |
| `updated_at` | 最近一次修改时间，跨设备合并用 |
| `deleted_at` | 墓碑时间；删除不物理删行 |
| `device_id` | 写入它的设备，跨设备合并用 |

#### `corrections`

| 列 | 一句话 |
|---|---|
| `id` | 纠正证据的唯一标识 |
| `soul_id` / `user_id` | 归属 |
| `at` | 这条纠正被**识别**的时间（不是发生时间）|
| `user_text` | 用户原话，证据本体，不做任何改写 |
| `assistant_text` | 被纠正的那一轮回答 |
| `layer` | 哪一层判出来的：`rule` / `structural` / `llm` |
| `signal` | 具体信号：`explicit` / `negation` / `replacement` / `meta` |
| `confidence` | 判定置信度 0–1 |
| `target_memory_id` | 能定位时，指回被纠正的那条记忆 |
| `marker` | 命中的词或模式，用来解释"为什么记这条" |
| `device_id` | 写入设备 |

#### `emotions`

| 列 | 一句话 |
|---|---|
| `passion` | 热情：主动投入的程度 |
| `bond` | 联结：关系亲近度 |
| `tension` | 张力：紧张与谨慎程度；被纠正时推高 |
| `self_regard` | 自我评价：对自己输出可靠性的判断 |
| `curiosity` | 好奇：主动探索的倾向 |
| `contentment` | 满足：倾向收敛、少确认的程度 |
| `updated_at` | 最近一次更新的时间 |

> 六维各 −2~+2，基线 0.3（`tension` 0.1）。它们不改"说什么"，只改"怎么说"（ADR 0017）。

#### `affect_samples`

| 列 | 一句话 |
|---|---|
| `soul_id` / `user_id` / `at` | 归属与采样时间 |
| `analyzer` | 哪个分析器产出的（`lexicon` / `llm`）|
| `dominant` | 主导**情绪族**（joy/anger/…），**不表示正负** |
| `intensity` | 强度 1–9 |
| `valence` | 极性加权值 −1~+1，负值代表负面 |
| `arousal` | 唤醒度 0–1 |
| `confidence` | 判定置信度 0–1；低于门槛不注入 |
| `payload` | 完整信号 JSON，**不含用户原文**（隐私底线）|
| `device_id` | 采样设备 |

#### `souls` / `schema_meta`

| 列 | 一句话 |
|---|---|
| `soul_id` | 灵魂标识，一个用户一个 |
| `name` | 注入时使用的自称 |
| `creator` | 创建者；目前无写入 |
| `created_at` | 相识时间，用于"相处了 N 天" |
| `k` / `v` | schema 版本号（当前 3）|

## 5. 需求

| 级别 | 需求 | 验收 |
|---|---|---|
| **必须** | 每一列都写得出"谁写、谁读、决定什么"，以及**一句语义说明** | 本文件 §4 的表格与 §4.5 无空格 |
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

已决（2026-10-30）：

- ~~六维 vs PAD~~ → **保留六维**，理由与代价见 §4.3
- ~~`semantic` 与 `fact` 的边界~~ → 按**抽象层级**区分，判定顺序见 §4.1.1；S2 仍无消费者则删
- ~~`valid_until` 谁来写~~ → 由**取代路径**写（新事件终结旧事实），时间取新事件的表达；`valid_from` 同步保留。见 §4.1.2

仍开放：

1. **时间表达提取**：抽取器能识别"2020 年 / 上个月 / 现在"吗？这是 §4.1.2 的前提，做不到两列就是死的。
2. `target_memory_id` 怎么定位：需要把"上一轮回答"映射到"当时注入的记忆"，`context().used` 已经有 id 列表。
3. 删列会让协议版本变化（`spec/protocol.v0.md`），是否需要 v1？
