> **⚠ 已废弃（2026-11-02）** —— 本文的设计已被 **ADR 0032 两层记忆** 取代。
> 事实模型改为世界层/人物层两层，时间改为可定位精度。
> 保留仅作历史记录，**不要按本文实现**。当前权威文档见 [docs/README.md](../README.md)。

# 模型 v0：实体、事实、槽位、缺口

- 状态：**Superseded（2026-11-02，→ ADR 0032 两层记忆）**
- 日期：2026-11-01
- 依据：[0013 事件模型](../briefs/0013-event-model.md)（DuEE 1.0 实测）、[0012 人物层](../briefs/0012-people-layer.md)
- 规则：**每一列必须被一个真实问题点名；点不到的不进。**

---

## 1. 四张表

```
entities     谁能被提到
  └ facts    发生了什么（一条事实）
      └ fact_slots  事实的槽位：实体 或 字面值
gaps         不知道但想知道
```

`turn_pairs`（原文）、`corrections`（纠正证据）、`emotions` + `affect_samples`（状态）、`souls`（身份）保持不动。

## 2. entities

| 列 | 类型 | 谁写 | 谁读 / 决定什么 | 点名的问题 |
|---|---|---|---|---|
| `id` | TEXT PK | 首次提及 | 被引用 | — |
| `soul_id` | TEXT | 同上 | 隔离 | — |
| `type` | TEXT | 首次提及 | `person` / `thing` / `place` / **`self`** | 1、4、9、22 |
| `name` | TEXT | 首次提及 | 称呼 | 1、9 |
| `aliases` | TEXT (JSON) | 后续提及 | 指代匹配（"她"→小林） | 1、9 |
| `attrs` | TEXT (JSON) | 事件更新 | 具体属性（病情、婚否）；**未知即空，不编** | 3、13 |
| `first_seen_at` | INTEGER | 首次提及 | "认识多久" | 1、21 |
| `last_mentioned_at` | INTEGER | 每次提及 | 多久没提 → 该不该问 | 1、3、5 |

## 3. facts

| 列 | 类型 | 值 | 点名的问题 |
|---|---|---|---|
| `id` | TEXT PK | | — |
| `soul_id` | TEXT | | — |
| `kind` | —— | **已删除**（ADR 0027：分类是语义，归模型） | —— |
| `type_name` | TEXT NULL | **自由文本**（"裁员""道歉""请求"…），可空；代码不分支，只用于显示与检索 | 1、2、11 |
| `statement` | TEXT | 一句话，人类可读 | 全部 |
| `holder` | TEXT | `world` / `self` / `<entity_id>`（在某人心里成立） | 13、16、20、23、30 |
| `at` | INTEGER | 事件时间（可模糊，模糊程度记 `at_text`） | 5、6、12 |
| `at_end` | INTEGER NULL | 区间结束 | 6 |
| `place_id` | TEXT NULL | → entities(place) | 6 |
| `status` | TEXT | `open` / `kept` / `broken` / `superseded` / `none` | 4、14、17 |
| `confidence` | REAL | 0–1 | 24 |
| `source` | TEXT | `experienced` / `told` / `inferred` | 24 |
| `source_turn_id` | TEXT NULL | → turn_pairs.id（回溯原文） | 23、27 |
| `superseded_by` | TEXT NULL | 状态变化的后继事实 | 2 |
| `created_at` | INTEGER | | — |

## 4. fact_slots（角色与数值合一张）

| 列 | 类型 | 说明 | 点名的问题 |
|---|---|---|---|
| `id` | INTEGER PK | | — |
| `fact_id` | TEXT | → facts.id | — |
| `slot` | TEXT | **事件自带的槽名**（自由文本）：出售方 / 离职者 / 涨价幅度 / 方式 / 原因 / 内容 | 1、8、9 |
| `value_type` | TEXT | `entity` / `number` / `text` / **`fact`** | — |
| `entity_id` | TEXT NULL | value_type=entity 时指向实体 | 1、2、9 |
| `value_num` | REAL NULL | 人数、金额、幅度、刑期 | 3、12 |
| `value_text` | TEXT NULL | 名字、模糊值（"3 人左右"）、命题内容 | 6 |
| `ref_fact_id` | TEXT NULL | value_type=fact 时指向另一条事实（回应、原因、反驳） | 8、15、18 |

**为什么合一**：91% 的角色名只出现一次，且 `死亡人数`/`涨价幅度` 这类不是实体。三种值（实体、数值、事实）结构相同，合成一张少两个概念。

**为什么没有 `core_role`**：它是让代码给角色分类，违反 ADR 0027。按实体查只用 `entity_id` 索引，不看槽名。

**为什么槽位能指向事实**：对话里大量是"对前一条的回应"——提问→回答、主张→反对、事件→原因。这同时补上了 ACE/DuEE 缺的事实间关系，而且不需要新表。

## 5. gaps

| 列 | 类型 | 说明 | 点名的问题 |
|---|---|---|---|
| `id` | TEXT PK | | — |
| `soul_id` | TEXT | | — |
| `about_entity_id` | TEXT NULL | 关于谁（"她最近怎么样"） | 1、3、13、14 |
| `about_fact_id` | TEXT NULL | 关于哪件事（"那个项目黄了吗"） | 4、14 |
| `topic` | TEXT | 想知道什么 | 1、13 |
| `tension` | REAL | 张力，随时间增长 | 1、3 |
| `status` | TEXT | `open` / `closed` / `dropped` | 1、13 |
| `opened_at` | INTEGER | | 1 |
| `closed_at` | INTEGER NULL | | 1 |
| `closed_by_fact_id` | TEXT NULL | 哪条事实回答了它 | 1、13 |

**为什么缺口独立成表**：缺席需要**张力**（越久越想知道），事实不需要。它不是一种事实，是另一类东西。

## 6. 三条规则

1. **事实可以有零个实体槽**（"今天下雨了"没有实体，也是事实）；有实体的，按 `entity_id` 可查。
2. **`at` 必填**，不知道精确时间就记模糊串（`at_text`），不能留空。
3. **不物理删除**：状态变化用 `superseded_by`；忘记用 `deleted_at`。

> 规则 1 改过一次：原稿要求"每条事实至少一个槽"，太强——那会逼着给"下雨"造一个"天气"实体，是造假。

## 7. 与旧 schema 的差异

| 旧 | 新 | 原因 |
|---|---|---|
| `memories`（一张大表承担所有） | `facts` + `fact_slots` + `gaps` | 职责混在一起，长条目无边界 |
| `importance` | 删 | 没有消费者（选择策略，不是事实属性） |
| `vividness` / `visibility` | 删 | 恒常量 |
| `valid_from` / `valid_until` | `at` + `superseded_by` | 重复 |
| `permanent` | 移到策略层 | 是排序行为，不是事实 |
| 无 | `holder` | 心理状态的成立位置 |
| 无 | `fact_slots.slot` | 角色是事件自带槽位，不是全局枚举 |
| 无 | `fact_slots.value_num` | 人数/金额/幅度 |

## 8. 尚未覆盖（已知缺口）

- **事实之间的时间关系**（before / after / 起因）——DuEE 不含这一层，TimeBank 才标注
- **群体实体**（"周围人家"、"他的员工"）
- **一般性陈述**（"所有乌鸦都是黑的"）——`type_name` + 槽位装得下文字，但"它是否成立"要模型判断
