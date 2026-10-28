# ADR 0023：DSH 适配器（T0 + 可移植转写）

- 状态：Accepted
- 日期：2026-10-28
- 关联：ADR 0007（接入阶梯）、ADR 0019

## 背景

ADR 0007 定的 T1 是"transcript 摄取"，当时假设宿主会话文件可读。实际验证发现问题：

DSH 的会话文件 `.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd` 是**多帧 zstd 容器**：

- `zstdDecompressSync(bytes)` 只解出第一帧 → 一个 session 头对象
- 流式 `createZstdDecompress` 在第二帧处报 `Unknown frame descriptor`
- 后续帧不是标准 zstd 帧（可能是自定义分帧或不同参数）

继续逆向的代价：格式私有、无文档、随时可能变。这与 ADR 0007 自己写的风险（"T1 依赖宿主的私有存储格式，一改就断"）完全一致。

## 决定

**T0 为主，T1 改为可移植格式。**

### T0：`SKILL.md` + CLI（`adapters/dsh/SKILL.md`）

- 会话开始：`soulbridge context --query "<首句>"`
- 每轮：`soulbridge observe "<user 原文>"`
- 会话结束（可选）：`soulbridge ingest --file transcript.jsonl`

SKILL.md 里同时写了五条硬规则（不转述、不改事实判断、失败不阻塞、不编造记忆、不写进仓库）。

### T1：`transcript.v1.jsonl`（宿主无关）

```jsonl
{"role":"user","content":"…"}
{"role":"assistant","content":"…"}
```

- 解析器接受四种常见形态（`role/content`、`type/text`、`message{role,content}`、数组 content）
- 跳过：header、tool、tool_result、thinking、无法解析的行
- 连续重复行合并；单条上限 20k 字符；最多 5000 轮

## 后果

**正面**

- 不绑死任何宿主的私有存储
- 同一个 ingest 命令对 Claude Code / Pi / 自建 agent 都成立
- 即使拿不到转写，T0 的 `observe` 也能逐轮积累

**负面**

- DSH 用户需要自己导出转写（目前没有一键导出）
- `observe` 依赖模型自觉执行（又回到"希望层"）——用 T1 的自动摄取补偿，在 DSH 上暂时只能靠 T0

**待验证**

- 在 DSH 上的真实遵从率（`context` 是否被放进系统提示、`observe` 是否每轮都调）
- 若遵从率低，需要做 DSH 插件而不是依赖 SKILL.md
