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
