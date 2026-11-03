# 2026-11-03 状态词表收口（C 步）review

> A9 门报"自 roles review 后有 3 个业务提交未整体看"，这是那次回头看。
> 改动：`12cb17e`（补提交 role 列）、`3ed2eb1`（测试路径）、`v0.0.101`（词表收口）。

## 1. 做成了什么

| 项 | 状态 | 证据 |
|---|---|---|
| 写方只写新值 | ✅ | `supersedeFact` → retracted；列默认 active |
| 迁移 v10 | ✅ | 线上 `schema_version=10`；旧值归零 |
| 读方只认新值 | ✅ | `roles.ts` 删掉双词汇回落；282 测试 |
| 发布链 | ✅ | tag → CI 发布（core 0.0.101 / plugin 0.0.107） |

## 2. 迁移前后的真实数据

```
迁移前  active 525 · none 40 · retracted 51 · superseded 4
迁移后  active 573 · retracted 56
```

401 条 observation 里，读路径仍然正常：judgment 81 / rule 65 / profile 12。

## 3. 这次暴露的两个结构问题

**① 发布物可以早于仓库。** 0.0.98 的 tarball 是用工作区构建的，仓库里没有 role 列那批代码。
修法：发布只由 CI 从 tag 构建（已完成），本地不再直接 `npm publish`。

**② 0.0.x 的 caret 语义会咬人。** `^0.0.100` 只匹配 0.0.100，核心每发一版都要跟着发插件。
已改成 `>=0.0.100 <0.1.0`，0.1 时收紧。

## 4. 仍然欠着的（明写，避免当成已完成）

- `factsByTurns` 现在只取 active，但 `threadContext` 用它作归纳材料——**已撤回的事实不再当证据**，
  方向正确；还缺一条测试钉住它。
- `role` 仍由代码从旧中文类型名派生（写入时），按 0024 终态应由模型选、代码校验。
- 迁移脚本 `migrate-roles.mjs` 保留作历史参考，v10 之后不再需要执行。
