# ADR 0020：存储位置、身份与迁移

- 状态：Accepted
- 日期：2026-10-28
- 关联：ADR 0021（跨设备）

## 背景

跨工具的前提是"同一个数据库、同一个身份"。而原来的默认路径是 `./.soulbridge/soul.db`（跟着 cwd 走）——等于每个仓库一个 soul，跨工具根本不成立。

## 决定

### 1. 位置：按人，不按仓库

| 项 | 值 |
|---|---|
| 默认 DB | `~/.soulbridge/soul.db` |
| 覆盖 | `SOULBRIDGE_DB` |
| 测试/多 soul | `--db <path>` |

**旧路径不自动搬迁**：跨目录自动复制有误伤风险；首次在新路径运行若检测到 `./.soulbridge/soul.db`，打印提示：`soulbridge import --from ./.soulbridge/soul.db`。

### 2. 身份：配置文件是唯一真相

```json
{ "soulId": "xiaoling", "userId": "local", "name": "小灵", "deviceId": "dev_1a2b3c4d" }
```

- `soulbridge init` 写入；所有命令读取
- 优先级：`SOULBRIDGE_SOUL` / `SOULBRIDGE_USER` 环境变量 > 配置文件 > 默认值
- `deviceId` 首次生成后**永不改变**（同步的决胜依据）

### 3. 并发：多宿主同时开着是常态

| 措施 | 值 |
|---|---|
| WAL | 已启用 |
| 忙等超时 | `busy_timeout = 5000` |
| 写重试 | 3 次，50/150/450ms 退避 |
| 写入粒度 | `observe` 单条事务；`reflect` 批量一个事务 |

SQLite 单写者是有意的取舍：写都是毫秒级小事务，换 Postgres/服务化会破坏 `npx` 安装体验。

### 4. 迁移：版本号 + 事务 + 升级前备份

- `schema_meta.schema_version`，v1 之前视为 1
- 打开时读版本 → 依次升级；**升级前**复制 `soul.db` → `soul.db.bak-v<旧版本>`（只留最近一份）
- **拒绝降级**：DB 版本 > 二进制支持的最大版本 → `DB_NEWER_THAN_BINARY`，只读或退出，绝不写

### 5. 跨设备

不在本 ADR 内，见 ADR 0021。v0 只提供 `export` / `import`。

## 后果

**正面**

- 跨工具真正成立（同一路径、同一身份）
- 升级有备份、有版本闸门
- 并发写有重试，不会因两个宿主同时写而报错

**负面**

- 默认路径变更属于破坏性变更，老用户需手动 import
- 单写者在极端并发下仍会等待（最多 5s）

**测试**：T23 迁移、T24 拒绝降级、T25 并发写、T27 身份解析。
