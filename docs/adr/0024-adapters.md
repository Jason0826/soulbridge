# ADR 0024：宿主适配层的归属与契约

- 状态：Accepted
- 日期：2026-10-28
- 关联：ADR 0001（只做 soul 层）、ADR 0004（零依赖）、ADR 0007（接入阶梯）、ADR 0023（DSH 适配器）

## 背景

DSH 插件跑起来之后，出现一个边界问题：**插件逻辑该放在 core 里，还是独立包？**

两边都有诱惑：放 core 里发布简单（一个包），放外面则要维护两个仓库。但这是可逆性很差的决定——一旦宿主代码进入 core，所有用户都要承担宿主的 API 变动。

## 决定

### 1. core 不含任何宿主代码

`soulbridge` 包只包含：状态模型、SQLite、评分、context 组装、affect 分析、reflect、import/ingest。**不知道任何 agent 宿主的存在。**

### 2. 适配器是独立包，一个宿主一个包

| 宿主 | 包 | 形态 |
|---|---|---|
| DSH | `dsh-plugin-soulbridge` | cordis bundle（`dsh.bundle.patch`） |
| 其他 | 待定 | 各自独立 |

### 3. soulbridge 拥有**契约**，适配器拥有**接线**

契约（写在 `spec/protocol.v0.md` + 本 ADR）规定适配器必须做什么：

| 时机 | 必须调用 | 允许降级 |
|---|---|---|
| 会话开始 / 每次提示组装 | `context({ track: false })` | 失败则不注入 |
| 每条**用户**消息 | `observe(turn)` | 失败则跳过，不阻塞 |
| 会话结束 | `reflect(turns)` | 失败则丢弃 |
| 模型主动查记忆 | `recall(q)` / `remember(...)`（可选工具） | 无 |

**三条禁止**：

1. 不得改变事实判断（affect 只改措辞）
2. 不得把记忆内容编造进回答（没注入就是没有）
3. 不得把个人记忆写进项目文件或仓库

### 4. core 为适配器提供的稳定面

适配器只能用这些，其余视为内部实现：

```
openSqlite(path)          Soul 类（context/observe/recall/remember/reflect/analyze/stats）
ensureConfig()            resolveDbPath()
buildContext({ track })   AffectSignal / Emotion 类型
```

`track: false` 是专为适配器加的：宿主每轮会多次组装提示，**不能每次都累加召回次数**。

## 理由

| 方案 | 问题 |
|---|---|
| 宿主代码放 core | 零依赖承诺破产；宿主 API 一变就要发 core 版本 |
| 一个包管所有宿主 | 插件市场需要独立包身份与版本；装 DSH 的用户被迫下载别家适配器 |
| **独立包 + core 定契约** | 多一个仓库，但发布节奏解耦、契约集中 |

## 后果

**正面**

- core 保持零依赖、纯函数、可测试（49 个测试）
- 新宿主只需实现同一个四动词契约
- DSH 插件可以独立发版，跟随 DSH 的 API 漂移

**负面**

- 两个仓库、两套发布流程
- 契约漂移风险：core 改字段，适配器未必同步（靠 `spec/protocol.v0.md` 的版本号约束）

**判据（何时合并回 core）**

若出现第三个适配器、且 80% 代码与宿主无关，再考虑把公共部分抽成 `soulbridge/adapter-kit`；在那之前，重复是便宜的。
