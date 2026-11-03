# 2026-11-04 过夜批次进度报告

> 对象：用户（早上直接看这份，不用翻对话）。
> 范围：按 state.md / 0024 / vocabulary-map / 0018 的已定设计，把可独立完成的项做完。
> 每项都有：改了什么、怎么验、数据、没做的原因。

## 一、这一批完成

### B. 槽位收敛（core 0.0.103）

| 旧表示 | 新表示 | 数据 |
|---|---|---|
| `原则候选=是` 槽位 | `role=lesson` + `status=candidate` | 61 条 |
| `来源` 槽位（画像） | `证据` 槽位 | 54 条（重复的跳过） |
| 类型名 `待修` | `status=candidate` | 未分类教训 |

- schema v11 在打开库时迁移，测试 `schema-v11.test.ts` 覆盖映射；
- `factsByTurns` 增加 `includeCandidates`：**归纳证据只取 active**，晋升才看 candidate；
- 新增测试：被取代的事实不再作为归纳材料。

### C. 行为影响闭环（半个，测量已落地）

**已经存在的两条注入**（这次只核对，没有新写）：

```
规则   → 插件在 pre-step 注入 <rules fired="…">，日志 `rules fired: ids`
情绪   → core 在 pre-step 注入 <affect>，一组「触发条件 + 动作」而非描述
```

**新增 `scripts/rule-compliance.mjs`**：规则触发后 10 分钟内、且纠正文本命中该规则触发词，
算一次「疑似未遵守」。首轮真实数据（39 次触发）：

| 规则 | 触发 | 随后被纠正 | 疑似未遵守 |
|---|---|---|---|
| `fc_lg_mem_mvwnil1k_lv9s` | 8 | 5 | 63% |
| `fc_lg_mem_mvxzap5z_2goh` | 5 | 1 | 20% |
| `fc_lg_mem_mvwk3vsm_y15l` | 5 | 0 | 0% |
| 其余三条 | 1–4 | — | 样本不足，不判决 |

**这是代理指标，不是证明**：纠正可能只是新话题；脚本已先用触发词过滤，首版没有过滤时
给出 40–60% 的假信号，加上过滤后才变成上面这张表。报告里的数字按「疑似」读。

### D. 导出契约（core 0.0.104）

`Soul.portableBundle()`，三层：

```
archive.jsonl   全量：实体/事实/槽位/线索/缺口/轮次/步骤/纠正（含状态与 role）
summary.md      可读：规则、画像、结论、承诺、实体、未闭合缺口
injection.txt   当前模型会看到的那段文本
```

CLI：`soulbridge export --dir <目录>`。真实库实测：

```
3822 条记录 · archive 6.9 MB · summary 16 KB · injection 2.3 KB
摘要里没有原始对话（原文只在 archive），这是设计：摘要是给人读的
```

## 二、没做的，以及为什么

| 项 | 为什么没做 |
|---|---|
| ⑤ 实体池清理（10 个术语实体、23 个名字编码 id） | 这是**数据判断**：哪些该合并、哪些是术语，需要你确认后再动；做错了不可逆 |
| `依据` 槽的消费者 | 225+ 条写了没人读。要给它消费者，得先定「推断证据在什么时候被使用」——这是设计问题，不是补一行查询 |
| 情绪 → 行为的**遵守率** | 规则有客观信号（纠正），情绪没有。现在只能测「是否注入了」，测不了「是否改变了行为」；等规则侧跑出样本再复用机制 |
| 读书验收 | 你自己定的：闭环可用后再做 |

## 三、明早你可以直接验的三件事

```powershell
# 1. 看规则遵守率（只读，不动数据）
node scripts/rule-compliance.mjs

# 2. 导出一份完整档案，翻 summary.md 看它现在怎么描述你
node packages/cli/src/cli.ts export --dir D:\tmp\soul-export

# 3. 看数据现状
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.soulbridge/soul.db',{readOnly:true});console.log(db.prepare('SELECT status, COUNT(*) n FROM facts GROUP BY status').all())"
```

## 四、下一步（按依赖顺序）

1. 实体池清理：先出一份「疑似术语/重复」清单给你看，不直接改；
2. `依据` 的消费者：定「推断类事实在回答时是否要声明依据」，再写；
3. 情绪行为层：复用规则的「触发词 + 动作 + 纠正信号」结构，等规则侧有 ≥20 样本；
4. 让模型选 `role` 的提示词效果评估：看真实抽取里 `角色=` 出现的比例与准确率。
