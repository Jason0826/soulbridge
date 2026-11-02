# 状态对照表（设计 ↔ 代码 ↔ 实测）

> 用途：**让你能核对我的理解**，而不是听我复述。
> 每一行都有出处：设计在哪一行、代码在哪一行、数字怎么来的。
> 权威性：代码 > 本表 > 我的口头总结。发现不一致时，以代码为准并改本表。

最后核对：2026-11-02 09:30

## 一、当前架构（一句话）

```
轮次（turns/steps）→ 事实（facts/entities/gaps）→ 线索（threads）→ 结论（facts 里 type=结论）
```

每层都有确定性闸门；模型只负责语义，失败有地板（ADR 0031）。

## 二、设计与实现对照

| # | 设计（出处） | 代码事实 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 一轮是完整往返，不是一问一答 `0010 §4` | `turns` + `steps`；`turn/end` 触发写入 | 每轮 1–4 步，`steps.kind` 有 text/reasoning | ✅ |
| 2 | 推理存但不注入 | `recordTurnPair({steps})`；召回只读 `assistant_text` | 5 条 reasoning / 8572 字符 | ✅ |
| 3 | 抽取 = 模型填表 + 确定性闸门 `ADR 0029` | `prompts.ts renderExtractionPrompt` + `extract.ts validateDraft` | 90.9% 走模型；`无` 1 字符可解析 | ✅ |
| 4 | 不记对话动作（请求/提问） `0016 §4` | prompt 的 `<when-to-write>` 四类 | 请求类消息产出 `facts=0` | ✅ |
| 5 | 话题不是段，是线索（A B A） `0017 §4` | `threads` 表 + `turns.thread_id`；`applyThread` | A1/A2/A3 同线索，B1 独立 | ✅ |
| 6 | 线索按"空闲轮数"闭合 `0017 §4.3` | `closeIdleThreads(currentTurnNo, idleTurns)` | 6 为默认，可配；幂等 | ✅ |
| 7 | 归纳按线索，不按事实批次 `0017 §4.4` | `threadContext` + 两阶段 prompt | A B A：证据 3/3，含最后回来那轮 | ✅ |
| 8 | 结论 = facts 行 + 证据槽，≥2 证据 `ADR 0031` | `recordConclusion` / `conclusionSlots` | 3 条结论，闸门拦过 4 次 partial | ✅ |
| 9 | 系统提示词只放稳定内容 | `section` 88 字符（soul+style+affect） | 无 "section: changed" 抖动 | ✅ |
| 10 | 动态记忆走消息通道 | `buildRelatedContext`：锚点 + `<about>` + `<related>` + `<handoff>` | 注入 1.9–5.4KB | ✅ |
| 11 | "上次聊到哪" = 上一闭合线索 `0017 §4.5` | `lastClosedThread` + `renderHandoff` | **尚未被真实触发**（需跨会话） | ⏳ |
| 12 | 情绪读出用户状态 | 词典 `analyzeAffect`（模型未接） | 非零率 **2.9%** | ❌ |
| 13 | 可携带（导出契约） `ADR 0028` | **无导出实现** | — | ❌ |
| 14 | 行为影响（记忆改变行为） | **无**（0018 挂起） | — | ⏳ |
| 15 | 老 `memories` 表退场 | 只读冻结；锚点仍读它 | 81 条，无新增 | ⚠️ 冻结中 |

## 三、四个比率（`node scripts/quality.mjs --days 7`）

| 指标 | 值 | 通过线 | 判定 |
|---|---|---|---|
| 事实密度 | 0.29 条/轮 | ≤1.5 | PASS |
| 抽取走模型 | 91.5% | ≥80% | PASS |
| 结论支持率 | 100%（3 次） | ≥80% | PASS（样本小） |
| 情绪非零率 | 3.0% | ≥50% | FAIL |

口径：按轮去重（重试不算独立跑）、无 `reason` 字段的旧记录算"未测量"。

## 四、已知缺口（按优先级）

| # | 缺口 | 影响 | 在哪 |
|---|---|---|---|
| 1 | **情绪读不出** | 语气恒定，2.9% 命中 | 词典 vs 模型 |
| 2 | **行为影响没做** | 记住了但行为不变 | 0018 Deferred |
| 3 | handoff 未真实触发 | 跨会话续聊未验证 | 需新会话 |
| 4 | 导出契约未实现 | 换机器/换工具带不走 | ADR 0028 第 3 条 |
| 5 | 线索主题质量差 | 出现"做吧""做"当主题 | 归属 prompt |
| 6 | 老 memories 只读 | 锚点来源仍是旧表 | 等结论层替换 |
| 7 | `threadIdleTurns=6` 未验证 | 阈值是猜的 | 等真实数据 |

## 五、怎么自己核对

```powershell
cd D:\git-workspace\repos\soulbridge

# 1. 四个比率（ADR 0031）
node scripts/quality.mjs --days 7

# 2. 某条线索的完整验收（A B A）
node scripts/abba-check.mjs --topic 核桃

# 3. 装上去的东西是否真的对
node --experimental-strip-types scripts/verify-installed.mjs
```

## 六、我说错过的判断（供你校准）

| 我说过 | 实际 | 错在 |
|---|---|---|
| "抽取走模型只有 52.9%，最该修" | 按轮去重后 90.9%，21:00 之后 100% | **指标写错**：重试被当成独立失败 |
| "情绪一写就立刻影响这轮语气" | pre-step 在提示词组装之后，最早下一轮 | 没读 agent-loop 时序 |
| "让模型输出 JSON 是可行的" | 54 字符被丢两小时 | 把格式契约押在 hope 上 |
| "新会话历史干净所以恢复" | 正常会话反而更老 | 没查创建时间 |
| "我们完全没有衰减" | recency 有 30 天半衰期 | 没读 scoring.ts |
| "注入是空回复的诱因" | 关掉注入仍复现 | 单次实验就下结论 |
