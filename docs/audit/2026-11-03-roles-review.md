# 2026-11-03 晚间 review（角色/状态迁移）

> A9 机器门报"自下午 review 后有 3 个业务提交未整体看"，这是那次回头看。
> 改动：`d469b1b`（A：读方双词汇）、`d469b1b` 后续（role 持久化）、迁移脚本执行。

## 1. 这次做成了什么

| 项 | 状态 | 证据 |
|---|---|---|
| A：读方同时认新旧值 | ✅ | `roles.ts` 单一裁决；282 测试 |
| B：数据迁移 | ✅ | 备份 `soul.db.bak-roles-1793706000354`；role 分布符合预期 |
| role 持久化 | ✅ | `putFact` / `setFactTypeName` 派生，否则新规则/画像会变 observation |
| C：删回落逻辑 | ⬜ 待办 | 需要确认没有旧数据再生 |

## 2. 迁移后的真实分布

```
status  active 470 / retracted 51（不再有 none/superseded）
role    observation 296 / judgment 79 / rule 65 / profile 60 / lesson 13 / promise 8
        role 为空 0
读路径  judgment/active 77 · rule/active 65 · profile/active 12
```

`profile/retracted 48` 是预期：画像合并时旧行被取代。

## 3. 这次自己发现的洞（A9 的价值）

**新写入不带 role。** 迁移只回填了历史行；`putFact` 默认 `role='observation'`，于是迁移之后
新产生的规则/画像/结论会悄悄从 `rules()`/`profile()`/`conclusions()` 里消失。
测试全绿、健康检查全绿——**只有回头看数据流时才看得见**。已在写入与类型变更两处补上派生。

## 4. 仍然存在的结构问题

- `role` 目前由**代码从旧中文类型名派生**，模型仍然只写 `type_name`。按 0024，长期应该是
  模型在抽取时明确选 `role`，代码校验。现在这层是**过渡**，写在这里避免被当成终态。
- 迁移脚本里有一份 `ROLE_BY_TYPE` 副本（脚本不能 import TS）。这是已知的第二个声明点，
  退场条件是：模型直接产出 role 之后，脚本只在一次迁移里用到。
- 归纳仍受"每轮一次调用"的天花板限制（0024 §3），这次没动。

## 5. 下一步

1. 观察几轮真实抽取：新事实是否按预期带 role（日志/库里查 `role='observation'` 的增量里
   有没有本该是规则/画像的）。
2. C：删回落（`typeName` 映射与旧状态集合），并在删之前确认没有 `status='none'` 的新写入。
3. 回到 0024：让模型选 `role`，代码只校验值域。
