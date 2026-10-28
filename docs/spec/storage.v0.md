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
