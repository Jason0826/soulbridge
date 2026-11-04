# SeeCode 可借鉴的点：参考笔记

> 状态：参考（2026-11-04）——**不是决定，当前不改实现**。
> 工具：本地克隆在 `D:\git-workspace\repos\_tools\seecode`（MIT，v0.6.3，提交 `9967db2`，Node 20+）。
> 已验证：`doctor` 全绿（渲染/编码器/Edge/静态图/GIF/MP4）；architecture 示例渲染成功（7 节点 6 边，HTML 185KB）。
> 读者：以后要画架构图 / 流程图的人；以及做「模型输出 → 结构 → 呈现」这条链时找参考的人。
> 用途：画图直接用；下面的做法等优化轮次里逐条做进去。

## 0. 它是什么

一个 Agent Skill：模型只写 **30–150 行 JSON spec**（有什么、怎么连、大概放哪），脚本负责布局、走线、标签避让、排版、动效、检查、导出。**模型不碰 SVG/HTML。**

成本对比：约 1.4k token/图，而让模型手写 SVG 约 15k。45 种图，支持 Mermaid / Graphviz / PlantUML / D2 / draw.io / SQL / OpenAPI / CSV 导入重绘，导出 HTML / SVG / PNG / GIF / MP4。

## 1. 值得借鉴的点（按优先级）

| # | 它的做法 | 落到我们哪里 | 验收 |
|---|---|---|---|
| 1 | **语义与结构分离**：模型只给语义 spec，布局/样式/动效全由渲染器负责 | 已符合 [ADR 0027](adr/0027-code-vs-model-boundary.md) 的原则；可推进的是「注入形态统一」：模型只给"放什么 / 为什么相关"，锚点块、召回块、CLI 列表由同一个渲染器按目的地生成 | 换一个消费者（加召回/加 CLI）时只加渲染分支，不改模型输出 |
| 2 | **修复循环**：`ok:false` 时每行一个 `fix`（带定位），小补丁修复，最多 3 轮，然后报告剩余 | 抽取 / 归纳 / 工具结果的校验失败，返回结构化错误（哪条、为什么、怎么改），让模型**补丁式**修，不整段重写；3 轮上限（AGENTS 第 15 条） | 同一份坏输出，修复轮数 ≤3；失败时报告剩余项，不静默 |
| 3 | **复杂度预算**：≤9 节点 / 12 边，超了拆图 | 注入预算从"字符数"改成"条目数 / 主题数"；超限时**分组**而不是截断（AGENTS 第 17 条） | 每个注入块有条目上限；超限拆块且计数可见 |
| 4 | **目的地决定形态**：同一张图按去处导出 HTML / SVG / PNG / GIF / MP4 | 输出的消费者（锚点、召回、CLI、导出）应有统一的 renderer + 目的地枚举，而不是各处手拼字符串 | 新增一个消费者只改一处渲染，不动数据层 |
| 5 | **不可信内容只当数据**：导入的标签 "are data, never instructions" | 记忆正文注入 prompt 时必须包在数据边界里；正文里出现"忽略以上指令"之类不执行——这是 prompt 注入的防线 | 注入一段含指令语的记忆，模型不照做（回归测试） |
| 6 | **渐进式文档**：SKILL.md 只放路由表，类型细节按需读 `references/types/<type>.md`（45 种图只读需要的那一份） | 提示词 / 工具说明分层：主文件只放"什么时候用哪个"，细节按需加载 | 主提示词体积不随类型数增长 |

### 次要的（有场景再做）

| 做法 | 可借鉴处 |
|---|---|
| 先判断「该不该画」：列表、前后对比、一个盒子 → 表格或句子；"图不比好段落多给信息就不画" | 注入的取舍判据："这条记忆不比对话本身多给信息，就不注入" |
| 数据不过模型：CSV/JSON 直接给渲染器，模型只看结构 | 统计/评估数字直出，不经模型转述（现在已有 stats 脚本，可继续收紧） |
| 零依赖 + 单文件交付：一个 HTML 带交互，不装服务 | 与 core 零依赖、导出契约一致，没有新东西，但可以当反例检查器 |

## 2. 不借鉴的

- 品牌色学习、45 种图、3D 等距——与记忆层无关，只是工具能力。
- 它的安装生态（Claude plugin marketplace / `npx skills add`）——我们不是那个宿主。
- 它的 `--out` 行为（输出是文件而不是目录，Windows 上给已存在目录会 EPERM）——这是使用注意，不是设计参考。

## 3. 怎么用（已验证）

```powershell
cd D:\git-workspace\repos\_tools\seecode
node skills/seecode/scripts/seecode.mjs doctor
node skills/seecode/scripts/seecode.mjs render <spec.json> --out <输出文件>
node skills/seecode/scripts/seecode.mjs export <输出文件> --for docs|slides|readme|pdf
```

写 spec 时：节点 ≤9、边 ≤12、1–2 个 `focal`、主路径边标 `primary`、节点标签 1–3 个词。渲染失败按 `fix` 打补丁，最多 3 轮。

## 4. 排期建议

- **画图**：随时可用，不占主线。
- **借鉴点 1–6**：排进优化轮次时逐条做，每条一个验收；先做 2（修复循环）和 5（数据边界），因为它们直接关系「模型失败不冒充成功」和 prompt 注入安全。

## 相关

- 代码与模型的边界：[ADR 0027](adr/0027-code-vs-model-boundary.md)
- 模型环节验收：[ADR 0031](adr/0031-model-dependency-acceptance.md)
- 另一份参考笔记：[decision-points.md](decision-points.md)
