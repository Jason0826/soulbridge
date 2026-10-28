# 宿主适配器

soulbridge 的核心不知道任何 agent 宿主的存在（[ADR 0024](../adr/0024-adapters.md)）。
把四个动词接到具体宿主上的代码，都在这里列出的独立包里。

## 现有适配器

| 宿主 | 阶梯 | 形态 | 位置 |
|---|---|---|---|
| DSH | T0 | `SKILL.md`（模型自觉调用 CLI） | [dsh/SKILL.md](dsh/SKILL.md) |
| DSH | T2 | cordis 插件（系统提示注入 + 事件观察） | [dsh-plugin-soulbridge](https://github.com/Jason0826/dsh-plugin-soulbridge) |

> T1（会话转写摄取）与宿主无关：任何宿主导出 `transcript.v1.jsonl` 后，用
> `soulbridge ingest --file` 即可，见 [spec/transcript.v1.md](../spec/transcript.v1.md)。

## 适配器要做什么

| 时机 | 调用 | 失败时 |
|---|---|---|
| 提示组装 | `context({ track: false })` | 不注入 |
| 每条用户消息 | `observe(turn)` | 跳过 |
| 会话结束 | `reflect(turns)` | 丢弃 |
| 模型主动查询（可选） | `recall` / `remember` | 返回空 |

## 三条禁止

1. 不改变事实判断——affect 只影响措辞
2. 不编造记忆——没注入的就是没有
3. 不把个人记忆写进项目文件

## 自己写一个适配器

只需要 `soulbridge` 包暴露的：（TODO: 补 `soulbridge` 的 SDK 入口说明）

```ts
import { openSqlite, ensureConfig, resolveDbPath, Soul } from 'soulbridge';

const config = ensureConfig();
const soul = new Soul({
  store: openSqlite(resolveDbPath()),
  soulId: config.soulId,
  userId: config.userId,
  deviceId: config.deviceId,
});
```

然后按上表在宿主的对应时机调用四个方法即可。
