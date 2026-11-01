# DSH 运行时：读源码得到的事实

- 日期：2026-11-01
- 来源：`app.asar` 内 `@deepseek-ai/dsh-*` 各包的 `README.zh.md` 与 `lib/*.js`（不是推测）
- 用途：soulbridge 插件开发前的事实基线

---

## 1. 启动：profile 怎么被组装成插件图

```
launcher → dsh-app-boot → 读 profile → Cordis loader → 服务 → 插件
```

profile 位于 `$DSH_HOME/profiles/<name>`，由两部分组成：

| 部分 | 内容 |
|---|---|
| `package.json` 的 `dsh.profile.bundles` | 有序的**组合包**列表 |
| `cordis.patch.yml` | 用户自己的 patch 层 |

**组合包（bundle）** 是一个包，它的 `dsh.bundle.patch`（或包里自带的 `cordis.patch.yml`）声明要插入哪些插件行。

我们自己的 `dsh-plugin-soulbridge` 就是一个组合包：

```yaml
# dsh-plugin-soulbridge/cordis.patch.yml
- insert:
    - id: soulbridge
      name: 'dsh-plugin-soulbridge'
```

所以**插件能被加载的唯一原因，是它出现在 `dsh.profile.bundles` 里**。

### 组装顺序（后面的覆盖前面的）

```
1. 各组合包层（按 bundles 列表顺序，每个包自己的 patch）
2. profile 的 cordis.patch.yml
3. home 级 patch
4. argv/单次启动 patch
```

### 一个真实事故（为什么插件会"消失"）

`dsh-app-boot` 里有个恢复函数 `sanitizeProfile(binName, profileDir, bundles)`，Desktop 在**致命错误恢复**时调用它：

> 它将 profile 的 `cordis.patch.yml` 重命名为 `.bak-<时间戳>`，并**恢复调用方指定的 bundle 列表**。

2026-11-01 21:11 的认证崩溃触发了它：

```
21:11:17  package.json 被重写（bundles 只剩 base + web-app）
21:11:17  cordis.patch.yml → cordis.patch.yml.bak-1793538677723
之后      插件不再加载（apply() 不再出现）
```

**教训**：插件不加载时，先看 `package.json` 的 `bundles` 和 `cordis.patch.yml` 的 mtime，而不是看代码。

---

## 2. 一轮的生命周期（agent-loop）

```
轮次边界
  ├─ 打开持久 turn
  ├─ 领取 inbox 中的 next-turn 消息
  └─ 组装提示词与工具 → 运行 agent/pre-step
        ↓ enter 决策
  step/start
  ├─ agent/request waterfall
  ├─ ctx.llm.prepareCall()（解析 provider/model/能力）
  ├─ 提交系统提示词与用户消息批次
  ├─ 冻结请求 → 流式调用
  └─ assistant/message（每个 step 一条）
        ↓ 还有工具调用就进入下一个 step
  turn/end
```

关键事实：

- **`agent/pre-step` 在提示词组装之后运行**。所以 pre-step 里写入的状态，最早**下一轮**才能出现在系统提示词里。
- `PreStepDecision` = `{ kind: 'reject' }` 或 `{ kind: 'enter', messages, startsRequestSeries? }`。
- 每个 step 都会调一次模型；一轮平均 5 个 step。

## 3. 消息注入的三个通道（源码）

`dsh-agent-loop/lib/index.js`：

```js
send(message, target, wakeup) { ... }
followup(input) { this.send(input, "next-turn", true); }   // 下一轮，并唤醒
steer(input)    { this.send(input, "next-step", true); }   // 下一步，并唤醒
inject(input)   { this.send(input, "next-step", false); }  // 插到下一位，不唤醒
```

三者都以**带 id 的 user 角色消息**进入会话，成为后续步骤读到的持久历史。

| 通道 | 目标 | 是否唤醒驱动器 | 适合 |
|---|---|---|---|
| `followup` | next-turn | 是 | 主动开口、排队输入 |
| `steer` | next-step | 是 | 中途引导（"别做 X"） |
| `inject` | next-step | 否 | **记忆上下文**（我们该用的） |

其余可观察事件：

| 事件 | 能做什么 |
|---|---|
| `agent/pre-step` | 拒绝步骤 / 替换进入的消息批次 |
| `agent/request-error` | **重试失败的模型请求** |
| `agent/turn-stopping` | 轮次关闭前运行，可 steer 让它保持打开 |
| `agent/assistant-stream` | 实时分片（呈现用，不是回放源） |
| `agent/inbox/*` | inserted / claimed / discarded 通知 |

## 4. 提示词组装（system-prompt 包）

| API | 时机 |
|---|---|
| `ctx.systemPrompt.section()` | 每步组装时求值 |
| `ctx.systemPrompt.context()` | **pre-step 之后**由 `refreshContext` 刷新 |
| `ctx.systemPrompt.variable()` | 每次组装插值 |

**`in-history` 语义**（DeepSeek 适配器声明 `systemPromptUpdate: "in-history"`）：

> 有效提示词不变时**不产生事件**；非空变更则**追加**，旧版本持续计入 token，直到压缩。

所以**系统提示词里放会变的东西 = 每次变化都多一个版本**。锚点这类会漂移的内容必须走消息通道。

## 5. 压缩（compaction）

- 自动触发：token 压力 / context-overflow；也可 `/compact` 按需、或指定范围。
- 行为：把较早的一段对话替换成**一条摘要 user/message**，近期历史不动。
- 度量：`ctx.tokenMeter`。
- 事件：`compaction/start` → `compaction/summary` → 表面只变一次（摘要消息）→ `compaction/end`。
- 工具配对边界：压缩不会切断未回答的 assistant 工具调用。

**含义**：宿主会压缩，所以"注入多少"不是宿主要求的硬约束；我们不该再用字符预算兜底。

## 6. 模型调用

- `ctx.llm.stream(...)` / `prepareCall()`：provider、model、能力（`systemPromptUpdate`、`toolUpdate`）在同一步内解析定值。
- 模型选择变化会在历史里插一条 `[model changed: …]` 的 user 消息。
- **插件发起的独立请求**（我们的抽取/归纳）不在这个循环里，没有工具、没有会话历史——只有我们拼的 prompt。

今天实测到的边界：插件发起的调用**只在轮内可成功**，但一次调用可以跨越多个 step（7.2 秒跨 3 步成功）。

## 7. 对 soulbridge 的直接结论

| 现状 | 应该 |
|---|---|
| pre-step 里 `{...decision, messages:[...note]}` 注入 | 改用 `agent.inject(...)`（文档化的通道；语义相同，但不由我们伪造决策） |
| 抽取在轮外触发过（失败） | 已经改成"下一轮 pre-step"，**这是对的方向**——但注意 pre-step 在组装之后 |
| 系统提示词里放过锚点 | 已移出；保持 section 只放稳定内容 |
| 用字符预算限制注入 | 不该有：压缩是宿主的职责 |
| 插件模型调用失败无从重试 | 宿主给了 `agent/request-error`，但只覆盖主轮请求；我们的独立调用要自己的重试（已有队列） |

### 待验证

- `agent.inject` 是否在插件 `ctx` 上可用（需要看 `Agent` 句柄暴露的接口，而不是 `send` 的内部实现）。
- `agent/request-error` 的确切载荷与返回值约定（能否用于插件发起的调用）。
