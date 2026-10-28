# spec/sync.v0 — 跨设备合并

- 状态：设计（实现于 v0.5）
- 关联：ADR 0021

## 1. 不做什么

- **不**把 `soul.db` 放进同步盘（WAL + 页级写入会损坏）
- **不**做云服务
- **不**做端到端加密（v1+）

## 2. 目录布局

```
<soulbridge-sync>/
  devices/
    dev_1a2b3c4d/
      memories-0001.jsonl
      affect-0001.jsonl
  state/
    dev_1a2b3c4d.json
```

- 每设备一个目录，只能写自己的分片（避免并发写同一文件）
- 分片 ≤1000 条，追加写；写满后新建 `-0002`
- 分片一旦写完**不再修改**（append-only 才可安全合并）

## 3. 记录

```json
{ "id": "mem_abc", "device": "dev_1a2b3c4d", "at": 0, "updatedAt": 0, "deleted": false, "payload": { } }
```

## 4. 合并

```
1. 读所有设备的全部分片
2. 按 id 分组
3. 同 id 取 updatedAt 大者
4. updatedAt 相等时取 device 字典序较大者
5. deleted = true 的记录保留为墓碑，不复活
```

实现：`packages/core/src/storage/merge.ts`（`pickLatest` / `mergeRecords` / `liveRecords`），T28/T29 覆盖。

## 5. 幂等

同一份分片导入两次结果必须一致：

- 记忆按 id upsert
- 采样按 `(soul_id,user_id,at,analyzer)` 唯一索引去重

## 6. 隐私

| 传输 | 数据是否出机 | 说明 |
|---|---|---|
| 手动 export/import | 用户自己决定 | 明文文件 |
| 同步盘（Dropbox/iCloud） | ✅ 出机 | 是否加密取决于盘商 |
| Syncthing（点对点） | ⚠️ 仅设备间 | 建议开设备加密 |
| Git 私有仓库 | ✅ 出机 | 加密取决于托管方 |

README 必须写明：**默认不出机；一旦使用同步盘或 Git，数据离开本机。**

## 7. 冲突的代价（诚实说明）

- 记忆以追加为主，冲突少；LWW 会丢并发编辑
- 情绪是弱信号，丢一次可接受
- 不做向量时钟/CRDT：单用户多设备的并发写本来就罕见，复杂度不值得
