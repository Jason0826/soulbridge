# 整体 review：0027 时间轴（2026-11-04 20:45）

> checklist A9：一项做完整体看一遍，不是再跑一次检查。
> 改动范围：core 的 `types` / `extract` / `prompts` / `sqlite` / `index` / `cli` + 抽取模板 + spec + 15 个测试文件；
> 迁移 schema v15（在真实库上跑过）。
> 一句话结论：**一个概念只留一个名字，代码不再替模型猜时间；旧的五个名字全部退场。**

## 一、新增了什么

| 东西 | 在哪 | 消费者 |
|---|---|---|
| `valid_from` / `valid_to` | `facts`（v15 迁移后） | 读取方、`personCard`、`soulbridge why`、CLI |
| `valid_from_text` / `valid_from_precision` | 同上 | 人工核对与精度判断 |
| 抽取模板的「有效从 / 有效到」+ 断言规则 | `packages/core/prompts/extraction-*.md` | 模型 |

## 二、有没有出现"同一件事的第二个表示"

这次改动的**目的**就是消灭一组两义名，所以重点看有没有生出新的：

| 候选 | 判断 |
|---|---|
| `valid_from` vs `created_at` | **不是**：一个是"内容什么时候成立"，一个是"我什么时候记下它"；断言类恰好相等，事件类恰好不等 |
| `valid_from_text` vs `valid_from` | **不是**：原话是证据（"上周三"），日期是换算结果；换算失败时只有前者 |
| `valid_from_precision` | 属性，不是第三条轴；值域在 `config/status.ts` 一处声明 |
| 插件里的 `turn-cost` 的 `secs` | 无关（不同对象） |

## 三、旧的东西有没有退场（第 10 步）

```
退场：at / at_text / at_end / at_precision / valid_until  ← 五个名字，代码 + 数据库列
      对应 TS 字段：Fact.at / FactDraft.at / FactSpec.at 等 11 个字段
      死代码：upgradeToV9 里重新添加 at_precision 的那一行（会让健康检查一直报"缺 spec"）
复活检查：health-check 的列解析现在从 sqlite.ts 读不到它们（0 FAIL 已确认）
```

`docs/spec/storage.v0.md` 的 facts 表已按新列重写；`model.v0.md` 是**已废弃**文档，保留历史不动（README 废弃表里登记过）。

## 四、指标与数据变了吗

```
迁移前（v14）  874 条事实 · active 756 · active 且 valid_until=at 的 247 条（"当天失效"）
迁移后（v15）  874 条事实 · active 756 · active 且 valid_to 非空 0 条
             valid_from 有值 874/874 · precision day 246 / range 6 / relative 13 / unknown 609
             retracted 57 条按时关闭（关闭点=后继 valid_from）
```

**变的是数据语义，不是数量**：247 条被误标失效的正确判断回到"当前"里。

## 五、系统更简单还是更绕

- 列少了一个（5 → 4），名字自解释；写入端从"四个兜底表达式"变成"调用方给什么写什么"。
- 代价：迁移函数 +35 行、解析器多读两个键、模板 +240 字符（棘轮已记账）。
- 风险点（明写）：**模型现在必须自己填 `valid_from`**。如果它偷懒不填，`valid_from` 会是空的——比"代码猜一个错的"好，但会失去时间检索。下一步要在 `quality.mjs` 里加一个数：**断言类事实的 `valid_from` 空值率**。

## 六、待办（进 backlog）

1. `quality.mjs` 加两个观测：断言类 `valid_from` 空值率、`supersede` 引用失败率。
2. 迁移链的旧缺口：runner 里只调 v2/3/5/7/8/14/15，v9–v13 从未被调用（只有测试直接调）。这次没修，但要记着——它意味着 v10 以前的库跳步升级。
3. `turn-cost` 读进 `quality.mjs`（0026 遗留）。

## 七、证据

```
npm test                → 301/301
npm run typecheck       → 0 errors
node scripts/health-check.mjs → 0 FAIL / 18 WARN / 25 PASS
verify-installed（web profile）→ installed core 0.0.113 / plugin 0.0.113，all checks passed
v15 迁移实测（真实库）→ 见第四节；备份 soul.db.bak-v15-manual-*
```
