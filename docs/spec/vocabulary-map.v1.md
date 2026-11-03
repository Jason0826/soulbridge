# 词表 → 字段差异表 v1

- 状态：**草案**（0024 第 2 步的收尾；只列差异，不改代码）
- 上游：[vocabulary.v1](../spec/vocabulary.v1.md)（五层 / 三态）、[0024](../briefs/0024-soul-layer-rebuild.md)
- 数据依据：`soul.db` 实测（事实 496、槽位 733、状态 none 446 / superseded 50）

## 1. 一个必须先定的结构问题

今天的 `type_name` 同时承担两件事：

```
规则 / 画像 / 判断 / 决定 / 特点 …   ← 这是"它是什么"（语义）
待修 / 候选 …                        ← 这其实是"到哪一步"（生命周期）
```

词表 v1 说“规则/画像/待修 不再是类型，而是状态”——**这句话只对了一半**：
“待修”确实是状态，但“规则 vs 画像”是**用途不同**，不是“生没生效”。

所以需要**两个字段**，各自封闭：

| 字段 | 归谁 | 值域 | 消费者 |
|---|---|---|---|
| `role` | 模型选（闭合集） | `observation` `judgment` `rule` `profile` `promise` `lesson` | 规则注入、画像注入、归纳人选 |
| `status` | 代码写 | `raw` `candidate` `active` `retracted` | 注入过滤、升格、复核 |

`type_name` 退回**自由描述**（“裁员”“偏好”“BOM 教训”），代码不据此路由。

## 2. 逐表差异

### facts

| 字段 | 现在 | 差异 | 迁移 |
|---|---|---|---|
| `role` | **不存在** | **新增**（TEXT，闭合值域） | 按 `type_name` 回填：规则→rule，画像→profile，结论→judgment，承诺→promise，教训→lesson，其余→observation |
| `status` | `none/superseded` | **值域替换**为 `raw/candidate/active/retracted` | none→active（在用），superseded→retracted |
| `type_name` | 兼做类型与阶段 | 只做描述 | 不改值，只改用途 |
| `holder` | `world` / `self` / 实体 id | **保留**，但读取时用实体名渲染 | 不改存储 |
| `source` | experienced/told/inferred | 保留 | — |
| `at_precision` | day/range/relative/unknown | 保留 | — |
| `confidence` | 0–1 | 保留 | — |

### fact_slots（733 条实测）

| 槽位 | 条数 | 判定 | 说明 |
|---|---|---|---|
| `依据` | 225 | **保留，但目前无人读** | ADR 0035 给 inferred 事实自动挂的转身 id。**要么给它一个消费者（承诺/教训的升格校验），要么删**——这是"写了没人读"的债 |
| `证据` | 37 | 保留 | 判断的证据（结论） |
| `触发` / `动作` | 64 / 64 | 保留 | 规则的两件套 |
| `维度` | 14 | 保留 | 画像的维度 |
| `原则候选` | 50 | **删除** | 由 `role=lesson` + `status=candidate` 表达 |
| `来源`（画像合并） | 54 | **并入 `证据`** | 同一件事两个名字 |
| `锚点` | 16 | 删除 | 锚点层已退场 |
| `关于` | 16 | 保留（缺口用） | 与 `gaps.about_entity_id` 同名概念，统一 |
| `主体` / `对象` / `承诺者` / `判断者` … | 其余 | 保留 | 语义槽位，模型自由写 |

### threads

| 字段 | 差异 |
|---|---|
| `topic` | 保留（模型可更新，ADR 0034） |
| `status` | 保留 `open/closed`（这是线索的生命周期，不与 facts 的三态混用） |
| `summary_fact_id` | 保留 |

### gaps

`gaps` 就是词表里的**第三种成立位置（落差）**，字段不动：
`about_entity_id` / `about_fact_id` / `topic` / `tension` / `status` / `closed_by_fact_id`。

### 待退场的表

| 表 | 处理 |
|---|---|
| `memories` | 读路径最后一段，退场登记 |
| `turn_pairs` | 只读迁移，退场登记 |

## 3. 三态迁移映射（一次性）

```
现在                     新
none（446 条，在用）  →  active
superseded（50 条）    →  retracted
—                      →  candidate（新增，尚无数据）
—                      →  raw（turns 里的原文，本来就不在 facts）
```

**注意**：`none` 全部映射到 `active`，因为它们已经在参与注入/规则。
新增的 `candidate` 一开始是空的——它由“证据不足的推断”“未确认的规则”产生。

## 4. 必须补的消费者（否则又是写了没人读）

| 字段 | 消费者（现在/应有） | 动作 |
|---|---|---|
| `role` | 规则注入、画像注入、归纳人选 | 新增三处查询，替换 `type_name='规则'` 这类判断 |
| `status` | 注入过滤 | 全部查询加 `status='active'` |
| `依据` | **无** → 承诺/教训升格时的校验 | 升格条件：`依据` 指向的 turn 存在且不是自述 |
| `domain` 槽 | **无** → 检索排序 | 只影响排序，不做分支 |

## 5. 这次不改的（明确记录）

- **不加 `episode` 表**：线索就是章节，不引入新词。
- **不动 sqlite 引擎**：只加一列、换值域，不做引擎替换。
- **不做多 soul**：作用域检查推迟（已定）。
- **不改 `holder` 存储值**：只改渲染。

## 6. 落地顺序

```
1  domains.ts 增加 ROLE / STATUS_V2 两个值域（数据，无逻辑）
2  facts 加 role 列；status 迁到新值域（事务 + 备份）
3  查询改读 role/status（三处：规则、画像、归纳人选）
4  槽位收敛：删 原则候选/锚点，来源→证据
5  给 依据 一个消费者（升格校验）
6  memories / turn_pairs 退场登记
```

**第 2 步是唯一不可逆的**（改的是值域），所以它必须在 1 之后、3 之前，且带备份。
