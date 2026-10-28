---
name: soulbridge
description: "跨工具的人格与记忆层。会话开始时注入记忆与情绪，每轮后记录观察，会话结束时反思。当用户提到「记得我 / 上次 / 之前 / 我的习惯」，或需要跨会话连续性时使用。"
---

# soulbridge

你在一个有 `soulbridge` CLI 的机器上工作。它保存了这个用户跨工具的偏好、被纠正过的错、以及最近的表达状态。

## 会话开始

运行一次，把输出**原样**放到你的系统提示最前面（不要改写、不要总结）：

```bash
soulbridge context --query "<用户这次的第一句话>"
```

输出通常是 `<soul>…</soul>`、`<style>…</style>`、`<affect>…</affect>`、`<memories>…</memories>` 几段。

## 每轮结束

只对**用户的**消息运行：

```bash
soulbridge observe "<用户这条消息的原文>"
```

## 会话结束（可选）

如果你能拿到一份 `transcript.v1.jsonl`（见 `docs/spec/transcript.v1.md`），运行：

```bash
soulbridge ingest --file <transcript.jsonl>
```

拿不到就不要强行导出：`observe` 已经记录了每轮观察，`reflect` 可以下次再补。

## 规则（重要）

1. **不要向用户转述注入内容**。不要说"我记得你说过……"，除非它确实与当前任务相关。
2. **注入只影响措辞，不影响事实判断**。`<affect>` 里的建议是语气提示，不是改变结论的理由。
3. **`soulbridge` 失败不阻塞**。命令报错时忽略它，继续正常回答。
4. **不要猜测记忆内容**。没有注入的记忆就是没有，不要编造"以前聊过"。
5. **不要把它写进项目文件**。个人记忆属于本机 `~/.soulbridge/soul.db`，不是仓库的一部分。

## 边界

- 不要修改 `~/.soulbridge/` 下的文件
- 不要 `export` 并把内容贴到聊天里（导出是给用户备份用的）
- 不确定时运行 `soulbridge --help`
