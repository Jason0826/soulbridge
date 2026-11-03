# spec/storage.v0 — 位置、身份、迁移

- 关联：ADR 0020、ADR 0021

## 1. 路径

| 项 | 值 | 覆盖 |
|---|---|---|
| 家目录 | `~/.soulbridge` | `SOULBRIDGE_HOME` |
| 配置 | `~/.soulbridge/config.json` | —— |
| 数据库 | `~/.soulbridge/soul.db` | `SOULBRIDGE_DB`、`--db` |

**默认不跟随 cwd**：跨工具要求所有宿主读写同一个文件。

## 2. 配置

```json
{
  "soulId": "xiaoling",
  "userId": "local",
  "name": "小灵",
  "deviceId": "dev_1a2b3c4d"
}
```

- `deviceId` 首次生成后**永不改变**（同步决胜依据）
- 优先级：`SOULBRIDGE_SOUL` / `SOULBRIDGE_USER` / `SOULBRIDGE_NAME` > 配置文件 > 默认值
- 环境变量覆盖**不写回**配置文件

## 3. 迁移

```
schema_version = 2   （无该行视为 1）
v1 → v2：memories.updated_at / memories.deleted_at / emotions.updated_at
```

- 升级前备份：`soul.db` → `soul.db.bak-v<旧版本>`（已存在则跳过）
- 升级在打开时完成，**幂等**（列已存在则跳过）
- DB 版本 > 二进制支持版本 → 抛 `DB_NEWER_THAN_BINARY`，不写入

## 4. 并发

| 项 | 值 |
|---|---|
| journal | WAL |
| busy_timeout | 5000ms |
| 写重试 | 3 次（50/150/450ms 退避），仅对 `locked/busy` 重试 |

## 5. 导出（JSONL）

```
{"type":"header","version":1,"soulId":"…","userId":"…","deviceId":"…","exportedAt":0}
{"type":"memory","memory":{…}}
{"type":"affect","at":0,"signal":{…}}
```

- 导入按 id 覆盖记忆；采样按 `(soul_id,user_id,at,analyzer)` 去重
- 导出是**明文**：文档必须提醒用户

## 6. 测试映射

| 条款 | 测试 |
|---|---|
| 配置与 deviceId | T27 |
| 迁移与备份 | T23 |
| 拒绝降级 | T24 |
| 并发写 | T25 |
| 导出导入 | T26 |

## 7. 字段说明（每列一句）

**这一节是契约的一部分**：代码里出现一列，这里必须有对应一句；`health-check` 会校验。
下面是当前 v3 的真实结构；v4 的增删见 [briefs/0009](../briefs/0009-schema-redesign.md)。

`souls`

| 列 | 一句话 |
|---|---|
| `soul_id` | 灵魂标识，一个用户一个 |
| `name` | 注入时使用的自称 |
| `creator` | 创建者；目前无写入 |
| `created_at` | 相识时间，用于"相处了 N 天" |

`emotions`

| 列 | 一句话 |
|---|---|
| `soul_id` / `user_id` | 归属；一个用户一条 |
| `passion` | 热情：主动投入的程度 |
| `bond` | 联结：关系亲近度 |
| `tension` | 张力：紧张与谨慎程度；被纠正时推高 |
| `self_regard` | 自我评价：对自己输出可靠性的判断 |
| `curiosity` | 好奇：主动探索的倾向 |
| `contentment` | 满足：倾向收敛、少确认的程度 |
| `updated_at` | 最近一次更新的时间 |

`memories`

| 列 | 一句话 |
|---|---|
| `id` | 记忆唯一标识 |
| `soul_id` / `user_id` | 归属 |
| `type` | 记忆分型（strategy / trait / fact / cognition / episodic / semantic / relationship）|
| `content` | 记忆正文，注入时展示的唯一内容 |
| `importance` | 1–10，值不值得占一个注入位 |
| `vividness` | 创建时定值 0.8/0.9；**没有更新路径，v4 计划删除** |
| `recall_count` | 被 `recall()` 命中的**累计**次数 |
| `status` | `active` / `superseded` / `archived`；`archived` 无写入 |
| `visibility` | 恒为 `private`；多人共养遗留，**v4 计划删除** |
| `keywords` | 中文 bigram + 英文词，用于词面相关性；可从 content 重建 |
| `created_at` | 这条何时被写进库 |
| `last_recalled_at` | 最近一次被召回的时间，供衰减派生 |
| `valid_from` | 事实开始成立的时间，可能远早于写入时间 |
| `valid_until` | 事实不再成立的时间；由取代路径写入，当前无写入 |
| `superseded_by` | 取代它的新记忆 id；当前无写入 |
| `updated_at` | 最近一次修改时间，跨设备合并用 |
| `deleted_at` | 墓碑时间；删除不物理删行 |

`turn_pairs`

| 列 | 一句话 |
|---|---|
| `id` | 交流唯一标识 |
| `soul_id` / `user_id` | 归属 |
| `session_id` | 宿主会话 id；与 `turn` 一起构成幂等键 |
| `turn` | 宿主轮次序号；同一 `(session, turn)` 只写一次 |
| `at` | 用户消息到达的时间 |
| `user_text` | 用户原话，不截断 |
| `assistant_text` | 助手回复，不截断；空串不允许（宁可整对不写）|
| `metadata_json` | 开放容器；未定字段先放这里（0010 §8）|
| `created_at` | 落库时间 |

`affect_samples`

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

`corrections`

| 列 | 一句话 |
|---|---|
| `id` | 纠正证据唯一标识 |
| `soul_id` / `user_id` | 归属 |
| `at` | 这条纠正被**识别**的时间 |
| `user_text` | 用户原话，证据本体，不改写 |
| `assistant_text` | 被纠正的那一轮回答 |
| `rule` | 命中的词或模式，用来解释"为什么记这条" |
| `device_id` | 写入设备 |

`schema_meta`

| 列 | 一句话 |
|---|---|
| `k` / `v` | schema 版本号（当前 3）|

## 8. 现行 schema 逐列说明（v7，ADR 0032 之后）

§7 记录的是 v3 的旧表；v6/v7 新增了 `turns`、`steps`、`entities`、`facts`、`fact_slots`、`gaps`、`threads`，
并给旧表补了列（`memories.updated_at`/`deleted_at`、`emotions.updated_at`、`facts.at_precision`/`recall_count`/`last_recalled_at`、`turns.thread_id`）。
下面是**当前代码里真实存在**的每一列，`health-check` 逐列核对这一节。

`schema_meta`

| 列 | 一句话 |
|---|---|
| `k` | 元信息键（当前只有 `schema_version`） |
| `v` | 值，文本存整数 |

`souls`

| 列 | 一句话 |
|---|---|
| `soul_id` | 灵魂标识，一个用户一个 |
| `name` | 注入时使用的自称 |
| `creator` | 创建者，目前无写入 |
| `created_at` | 相识时间，用于"相处了 N 天" |

`emotions`

| 列 | 一句话 |
|---|---|
| `soul_id` / `user_id` | 归属；一个用户一条 |
| `passion` / `bond` / `tension` / `self_regard` / `curiosity` / `contentment` | 六维关系状态，0–1 |
| `updated_at` | 上次更新时间（迁移补列） |

`memories`（旧表示，待退场）

| 列 | 一句话 |
|---|---|
| `id` | 记忆唯一标识 |
| `soul_id` / `user_id` | 归属 |
| `type` | 旧分型（strategy/trait/fact/cognition） |
| `content` | 记忆正文 |
| `importance` / `vividness` | 旧排序因子；`vividness` 无更新路径 |
| `recall_count` / `last_recalled_at` | 召回累计与最近时间 |
| `status` | active / superseded / archived |
| `visibility` | 恒为 private（遗留） |
| `keywords` | 中文 bigram，可从 content 重建 |
| `created_at` | 写入时间 |
| `valid_from` / `valid_until` | 旧的有效区间 |
| `superseded_by` | 被哪条取代 |
| `updated_at` / `deleted_at` | 迁移补列；`deleted_at` 软删除标记 |

`affect_samples`

| 列 | 一句话 |
|---|---|
| `soul_id` / `user_id` / `at` | 归属与采样时间 |
| `analyzer` | 分析器名（lexicon / llm） |
| `dominant` | 主导情绪族 |
| `intensity` / `valence` / `arousal` | 强度、极性、唤醒 |
| `confidence` | 判定置信度 |
| `payload` | 完整信号 JSON，不含原文 |
| `device_id` | 采样设备 |

`corrections`

| 列 | 一句话 |
|---|---|
| `id` | 纠正证据标识 |
| `soul_id` / `user_id` / `at` | 归属与识别时间 |
| `user_text` / `assistant_text` | 原话与那一轮回答，不改写 |
| `rule` | 命中原因 |
| `device_id` | 写入设备 |

`turn_pairs`（旧表示，只读）

| 列 | 一句话 |
|---|---|
| `id` | 旧交流单元标识 |
| `soul_id` / `user_id` / `session_id` / `turn` / `at` | 归属、位置与时间 |
| `user_text` / `assistant_text` | 双方原文 |
| `metadata_json` | 未定字段 |
| `created_at` | 写入时间 |

`turns`（一轮 = 一次完整往返）

| 列 | 一句话 |
|---|---|
| `id` | 轮次标识，也是事实的 `source_turn_id` |
| `soul_id` / `user_id` | 归属 |
| `session_id` | 宿主会话 |
| `turn_no` | 宿主轮次号，同会话内唯一 |
| `started_at` / `ended_at` | 开始与结束时间 |
| `user_text` / `assistant_text` | 双方原文，不截断 |
| `outcome` | 结束方式（正常/中断） |
| `status` | 记录状态 |
| `thread_id` | 所属线索；未归属为空（ADR 0034 后默认继续） |
| `created_at` | 写入时间 |

`steps`（一轮里的每一步）

| 列 | 一句话 |
|---|---|
| `id` | 自增主键 |
| `turn_id` | 所属轮次 |
| `idx` | 轮内序号 |
| `kind` | 步骤类型（reasoning / text / tool） |
| `text` | 该步正文；reasoning 存原文，**只存不注入** |
| `tool_name` / `tool_args_chars` / `tool_result_chars` | 工具调用与体积（不存工具参数原文） |
| `ok` | 工具是否成功 |
| `at` | 发生时间 |

`entities`

| 列 | 一句话 |
|---|---|
| `id` | 实体标识（`en_<type>_<随机>`；旧数据编码了名字） |
| `soul_id` / `user_id` | 归属 |
| `type` | person / thing / place / self（`config/domains.ts` 唯一声明） |
| `name` | 名字，身份的可读部分 |
| `aliases` | 别名 JSON 数组，指向同一实体 |
| `attrs` | 附加属性 JSON（如关系） |
| `first_seen_at` / `last_mentioned_at` | 首次与最近提及 |
| `created_at` | 写入时间 |

`facts`（一句话事实）

| 列 | 一句话 |
|---|---|
| `id` | 事实标识 |
| `soul_id` / `user_id` | 归属 |
| `statement` | 陈述，15–80 字，原文语义不截断 |
| `type_name` | 自由文本类型名（偏好/裁员/结论…），不设枚举 |
| `holder` | 成立位置：`world` / `self` / 实体 id（ADR 0032） |
| `at` / `at_text` / `at_end` | 时间、原话、区间结束 |
| `at_precision` | day / range / relative / unknown |
| `place_id` | 地点实体引用，可空 |
| `status` | none / open / kept / broken / superseded（`config/status.ts`） |
| `confidence` | 0–1；空字段不落 0 |
| `source` | experienced / told / inferred（ADR 0035 的来源不对称） |
| `source_turn_id` | 来自哪一轮，证据链 |
| `superseded_by` | 被哪条取代 |
| `created_at` | 写入时间 |
| `recall_count` / `last_recalled_at` | 被注入的累计与最近时间 |

`fact_slots`

| 列 | 一句话 |
|---|---|
| `id` | 自增主键 |
| `fact_id` | 所属事实 |
| `slot` | 槽位名（主体/工具/证据…），自由文本 |
| `value_type` | entity / number / text / fact（值的种类，结构字段） |
| `entity_id` | 实体引用的值 |
| `value_num` | 数值的值 |
| `value_text` | 文本的值 |
| `ref_fact_id` | 指向另一条事实（证据、原则候选） |

`gaps`（提过但没答案的事）

| 列 | 一句话 |
|---|---|
| `id` | 缺口标识 |
| `soul_id` / `user_id` | 归属 |
| `about_entity_id` / `about_fact_id` | 关于谁 / 关于哪条事实 |
| `topic` | 缺什么，一句话 |
| `tension` | 张力 0–1，决定提醒优先级 |
| `status` | open / closed / dropped |
| `opened_at` / `closed_at` | 开合时间 |
| `closed_by_fact_id` | 被哪条事实关闭 |

`threads`（线索 = 可跨中断的话题章节）

| 列 | 一句话 |
|---|---|
| `id` | 线索标识 |
| `soul_id` / `user_id` | 归属 |
| `session_id` | 开始时的会话 |
| `topic` | 一句话主题，随线索演进（ADR 0034） |
| `status` | open / closed |
| `opened_at` / `closed_at` | 开合时间 |
| `last_turn_no` | 最近一轮，用于"几轮前"与空闲闭合 |
| `summary_fact_id` | 闭合时归纳出的结论 |

