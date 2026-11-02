# 交接（Handoff）

> 新会话从这里开始读。读完这份 + 注入的记忆，再决定要不要动代码。
> 本文只写"现在是什么状态"；设计与理由在 [adr/](adr/) 和 [briefs/](briefs/)。

## 一句话

`soulbridge` 是给 agent 装的人格层（四个动词：context / observe / recall / reflect），
零运行时依赖，DSH 是第一个宿主。

## 现在的能力（2026-11-02）

```
对话 → turns + steps（含 reasoning，只存不注入）
     → 抽取：模型填表 + 闸门 → entities / facts / gaps
     → 线索：一轮属于一条线索（A B A 可跨中断续上），闭合后归纳
     → 结论：两阶段（起草 + 独立验证），≥2 证据，可被取代
     → 检索：主体优先路由（实体 / 连续性 / 时间 / 相关），按层取
     → 注入：消息通道（不进系统提示词），实体时间线按问题排序
     → 复习：被召回一次记一次，衰减变慢
```

## 版本与安装

| 组件 | 版本 | 说明 |
|---|---|---|
| core | **0.0.61** | schema **v8**（facts 带 recall_count / last_recalled_at） |
| dsh-plugin | **0.0.74** | 路由 + 实体时间线 + 去重注入 + 归纳三步 |

profile：`~/.dsh/profiles/desktop`（`node_modules/soulbridge`、`node_modules/dsh-plugin-soulbridge`）。

**安装规则：装完必须验证能 import，不能只信版本号。**
`node --experimental-strip-types scripts/verify-installed.mjs`

## 今天定下的三件事（会影响你怎么改代码）

1. **ADR 0031**：每个模型环节必须有四件套——闸门 / 地板 / 度量 / 可逆。缺一件不许进主干。
2. **ADR 0032**：记忆分两层。`holder=world` 是世界层（必须可定位），`holder=<实体>` 是人物层（某人的看法）。`type_name` 只是描述，**代码不许靠它路由**。
3. **0019/0020**：全部保留、不删除；衰减的是"被想起的概率"（幂律 + 复习）；检索是漏斗（定向 → 收钩子 → 按需下潜），上下文有预算。

## 已知的坑（都踩过）

| 坑 | 结论 |
|---|---|
| 用时间猜轮次边界 | 轮的边界是 `turn/end` 事件，不是静默 |
| 宿主 turn_no 当轮次计数 | 它每次用户发言跳 10–30，**要数 turns 行** |
| 用实体名兜底 | 不认识的名字仍然是主体，不能落到"上次聊到哪" |
| 用 `type_name` 分类 | 16 种标签碎片化；结构（holder + 时间）才是分类 |
| 中文全文检索 | FTS5 的 trigram 搜不到 2 字词；用二元分词 |
| PowerShell 改代码 | 模板字符串会被吃掉、`\n` 变字面量；**用 edit 工具** |

## 环境与工具

| 东西 | 在哪 |
|---|---|
| 重启 DSH | `dsh-plugin-soulbridge/scripts/restart-dsh.ps1`（必须由计划任务拉起，120s 延迟） |
| 重启日志 | `~/.soulbridge/restart.log` |
| 结构体检 | `soulbridge/scripts/health-check.mjs` |
| 质量比率 | `soulbridge/scripts/quality.mjs --days 7`（四个比率，ADR 0031） |
| 线索验收 | `soulbridge/scripts/abba-check.mjs --topic <词>` |
| 真实数据 | `~/.soulbridge/soul.db`、`plugin.log`、`trace.jsonl` |

## 当前数字（2026-11-02）

```
事实密度 0.3 条/轮 · 抽取走模型 94.9% · 结论支持率 100%(5/5) · 情绪非零率 2.1%(FAIL)
线索 23 条 · 归属覆盖率 42% · 无实体锚点 0%
```

**唯一的红是情绪**（词典 2 字命中率低），还没重做。

## 下一步（按优先级）

1. **抽取按 ADR 0032 改**：世界层要时间，人物层要 holder；用同一批 26 句验收
2. 时间归一（"上周三" → 日期），否则"上周下雨那天"仍答不出
3. 情绪重做（模型判定，不再靠词典）
4. 结论去重的簇合并（等结论到 20 条）

## 约定（必须遵守）

1. 改动前解释：为什么、怎么做、影响
2. 需求说明 → ADR → 实现 → 验证
3. 发版前 `npm test` 必须 fail 0，且 `verify-installed.mjs` 通过
4. 失败排查先保存原始输出，不猜
5. 报数据，不报感觉
