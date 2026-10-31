# 状态对照表（设计 ↔ 代码 ↔ 实测）

> 用途：**让你能核对我的理解**，而不是听我复述。
> 每一行都有出处：设计在哪一行、代码在哪一行、数字怎么来的。
> 权威性：代码 > 本表 > 我的口头总结。发现不一致时，以代码为准并改本表。

最后核对：2026-11-01 00:40

## 一、设计与实现

| # | 设计（出处） | 代码事实（文件:行） | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 记忆单元 = 一问一答 `briefs/0010 §4` | `turn_pairs` 表；`recordTurnPair` | 44 行，p50 493 / p90 1102 / max 1678 字 | ✅ 已实现 |
| 2 | 超过长度上限要提炼 `0010 §4` | **无** | 21/44 条超 500 字 | ❌ 未实现 |
| 3 | 原文不可变、派生可重建 `0010 §8` | `turn_pairs` 只有插入，无更新/删除路径 | — | ✅ |
| 4 | 三轴 type/subject/time `0010 §4` | `turn_pairs` 无 `subject` | — | ❌ |
| 5 | `metadata` 开放容器 `0010 §4` | `metadata_json TEXT DEFAULT '{}'` | 一直是 `{}` | ⚠️ 结构在、没写 |
| 6 | 注入分工：system prompt 放画像，pre-step 放片段 `0010 §10` | 插件：section 取 **memories**（importance≥8）；pre-step 取 **turn_pairs** | — | ⚠️ 片段侧对，锚点侧仍是旧机制（画像不存在） |
| 7 | 锚点不该用 `importance ≥ 8` 选 `0010 §10` | `dsh-plugin-soulbridge/index.js:207` | importance 只有 6/7/8/9 四档 | ❌ 仍是旧法 |
| 8 | 排序 = 相关 × 时效 × 证据（乘积） `0007 §4` | `packages/core/src/scoring.ts:139` 五因子**加权和** | — | ❌ |
| 9 | 删掉 `vividness` `0007 §4` | `scoring.ts:143` 仍参与；写入恒 0.8/0.9 | 去掉后 top-5 重合 0.95 | ❌ 仍保留 |
| 10 | relevance 换 BM25 `0007 §2` | `scoring.ts:160` `rank()` 用 bm25 | 18202 字那条 top3 命中 85% → 17% | ✅ |
| 11 | recency 要衰减 | `scoring.ts:21,118` 半衰期 30 天，起点 `lastRecalledAt ?? createdAt` | 已实现 | ✅ |
| 12 | 证据等级（纠正 > 用户 > 规则 > 归纳） `0007 §4` | **无** | — | ❌ |
| 13 | 纠正检测 L1/L2 `briefs/0008` | `detectCorrection`；插件已接 | `corrections` 45 行；`structural:negation` 精度约 11% | ⚠️ 有数据、质量差 |
| 14 | 注入 trace `briefs/0005-injection-trace` | 插件 0.0.43：`trace.jsonl` 记 blocks/usage/inject ids | 有块结构；**没有候选数与分数** | ⚠️ 部分 |
| 15 | MVP1：关掉重开能接上 `mvp.md` | 三块结构齐（turn_pairs → recallTurnPairs → pre-step 注入） | **未做实测** | ⏳ 待验收 |

## 二、已知的文档债

| 问题 | 影响 |
|---|---|
| **两个 brief 都编号 0005**（`0005-eval-harness.md`、`0005-injection-trace.md`） | 引用"0005"会歧义 |
| `briefs/0008` 状态写"真机 corrections 仍为 0 行" | 实际 45 行，文档滞后 |
| `references.md` 曾写"我们完全没有衰减" | **错**：recency 已有 30 天半衰期；缺的是 `vividness` 不动、`recall_count` 几乎不参与 |

## 三、怎么自己核对（三条命令）

```powershell
cd D:\git-workspace\repos\soulbridge

# 1. 评分到底用什么（看 139 行是不是加权和）
Select-String packages/core/src/scoring.ts -Pattern 'WEIGHTS|bm25\('

# 2. 注入分工（看第 207 行 ANCHOR 和第 290 行 turn_pairs）
Select-String D:\git-workspace\repos\dsh-plugin-soulbridge\index.js -Pattern 'const ANCHOR|recallTurnPairs'

# 3. 数据现状
node packages/cli/src/cli.ts stats
```

## 四、我这次会话里说错过的判断（供你校准）

| 我说过 | 实际 | 错在 |
|---|---|---|
| "新会话历史干净，所以恢复" | 正常会话反而更老（10-26 vs 10-30） | 没查创建时间 |
| "turn_pair 覆盖率 11%，MVP1 致命伤" | 上线后 74%，且真正的短板是长度无界与机制分工 | 分母含功能上线前的数据 |
| "我们完全没有衰减" | recency 有 30 天半衰期 | 没读 scoring.ts |
| "注入是空回复的诱因" | 关掉注入仍复现 | 单次实验就下结论 |
