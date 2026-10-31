# 参考基线：哪些文章还有用

> 这批资料来自项目早期的阅读（视频 / 文章），当时的假设是"自建 agent"。
> 项目转向"只做 soul 层"之后，**权重发生了变化**。下表是重新评估的结果。

---

## 仍然高价值

| 来源 | 原则 | 用在哪 |
|---|---|---|
| **Agent 架构分层** | 领域层 / 应用层 / 适配层 + 组装根；换模型只改一处 | `docs/architecture.md` 的目录与依赖规则；`ports/` 的划分 |
| **DSH 架构** | 会话即事件流；Step 是"一次模型请求 + 其工具调用"；权限挂在工具链路上 | **从"参考资料"升级为对接文档**：T1 适配器读的就是它的 `session.v4.jsonl.zstd`（ADR 0007） |
| **Agent 评估三维** | 结果 / 过程 / 成本，只看结果不完整；可观测性 = 可回放的结构化 trace | eval 指标设计（ADR 0010）；`no_repeat` 是"过程"指标 |
| **运维的可观测性** | SLI/SLO；警惕 Goodhart；"没有告警 ≠ 健康" | 禁止把 `recallCount` 当成功指标；`used` 是覆盖率不是有效性 |
| **从写代码到上线** | 外部裁判优于自审；线上事故 → 评测集；收敛规则 | 评审流程（不接受同源自证）；eval case 来自真实失败 |
| **小模型接管 Agent** | 不可逆操作规则留在代码；置信度 ≠ 本次正确；错误静默传播 | affect 层**不得**改事实判断；v0 不桥接"用户情绪 → 我的情绪"（R2 决策） |

## 降级为原则

| 来源 | 原则 | 现在的用法 |
|---|---|---|
| **马兆远：可检验事实** | 科学 = 有效陈述下的可检验事实；不可证伪的命题不作验收 | `docs/thesis.md` 的验收纪律：把"形成意识形态"明确排除 |
| **形式化验证** | TLA+ / TLC 穷举，给最短反例；证明模型 ≠ 证明系统；LLM 审 LLM 有同源盲区 | P3 可选：给记忆生命周期与四动词不变量建模；不作为 v0 依赖 |

## 已过期或需修正

| 内容 | 处理 |
|---|---|
| 所有"怎么造 runtime / agent loop"的细节 | **过期**：本项目不做 runtime（ADR 0001） |
| "RAG 是过渡产物，上下文变大会淘汰" | **修正**：只有**容量型**会贬值；**选择型**（该想起什么、何时想起、带什么权重）不会（`docs/thesis.md`） |
| 具体的百分比数字（成功率下降 19 个百分点、成本降 14.2%） | **会过期**：随模型迭代失效，只保留"不可逆操作导致静默错误"这个结构性结论 |
| 表达训练类内容（词库、报告维度） | **降级为输入侧素材**：只借鉴情感分类结构与强度修饰，不借鉴"训练用户表达"的产品目标（R2 处理） |

---

## 2026-10 新增：Harness²（Google Cloud AI Research）

- 论文：[arXiv 2610.14224](https://arxiv.org/abs/2610.14224)（2026-10-09）
- 代码：[google-research/harness2](https://github.com/google-research/harness2)（Apache 2.0）
- 前作：[Continual Harness](https://arxiv.org/abs/2605.09998)（2026-05，具身 agent，无重置、无人在回路）

一句话：**Agent = Model + Harness**，权重冻结，让 agent 自己改自己的外壳；两层级递归——任务内改执行 harness，任务间更新"改进 harness"。

| 来源 | 原则 | 用在哪 |
|---|---|---|
| **Harness²** | **没有 ground truth 也能改进**：提出候选 → 同条件探针 → 按**行为差异**组合（Propose–Probe–Compose），不判对错 | `briefs/0005` 的评估口径：把"找标准答案"换成"两臂受控对比" |
| **Harness²** | 只有被**执行对比**支撑的教训才入库；证据不足就不写教训 | 印证 `briefs/0007` 的 `evidence` 字段；也是"推测永不记"的外部版本 |
| **Harness²** | 跨任务只延续"改进库"，**执行 harness 每次重置回 H₀** | 确认 soulbridge 的空位：**没有人在做跨任务的"关于人"的连续性** |
| **Harness² 的失败分析** | 自我改进会引入退化（9 个回归；selector 曾选 55 分丢掉 95 分） | 支持 RFC 0003 B 阶段的 `pending → 人工确认`，不是保守，是有证据 |
| **成本公式（独立复核）** | 每个任务至少 `4k` 次执行（k 参考 + 2k 探针 + k 组合），不含编辑器/评判 | 我们的设计规则：**每次自我改进必须声明采样预算**；每轮注入这种高频决策不能照搬 |

**必须防的误读**：Harness² 的 8 个组件里也有一个叫 `memory`，但它是**上下文构建**（类似 AGENTS.md / 项目记忆），
不是跨会话的个人记忆。**同名不同物**，不能拿它论证"记忆层已被覆盖"。

**数字（会过期，只作量级参考）**：WorkBuddy 平均分 Gemini 3.5 Flash/OpenCode 72.4 → 单步 77.5 → k=5 80.8；
GLM-5/OpenCode 64.2 → 75.7。给 Gemini 调的 harness 原样交给 GLM-5，代码 58.5 → 75.8（跨模型迁移）。

**局限（来自论文与独立复核）**：判分仍以 LLM judge 为主（WorkBuddy 由 Gemini 3.5 Flash 判，与执行器同族）；
测试集小（WorkBuddy 用 100 条、JobBench 34 条）；不是处处赢（LAB 上 Meta-Harness 更强）；执行器网络不设限。

---

## 2026-10 新增：OpenJudge / PawBench（AgentScope）

- 框架：[agentscope-ai/openjudge](https://github.com/agentscope-ai/openjudge)（Apache 2.0，Python）
- 基准：[PawBench](https://github.com/agentscope-ai/PawBench)（Model × Harness 协同评测）
- 论文：[Voting with the Graph（TCR）](https://arxiv.org/abs/2510.15514)

一句话：**OpenJudge 讲怎么评，Harness² 讲怎么改。** 它提供 50+ 生产级评分器，包括智能体维度的 `Memory` / `Plan` / `Trajectory`，
评的不只是最终答案，还有轨迹和记忆。

| 来源 | 原则 | 用在哪 |
|---|---|---|
| **OpenJudge** | **评分器必须自带基准集与测试**，50+ 个 grader 靠这个保证可信 | `briefs/0005` 需求：每个 grader 配 fixture + 单测 |
| **OpenJudge** | 没有金标准也能评：从标注样本**自动学出 rubric**（`IterativeRubricsGenerator`） | `briefs/0005` §3.1 的第三条路——"说不清标准，但能标 20 条" |
| **PawBench** | **Model × Harness × 评分器**三分 + 切片诊断，定位回归来自哪一层 | `briefs/0005` 开放问题 6；将来做归因 |
| **PawBench v1.0** | 仅 harness 设计就能让**同一模型**分数差 10+ 分，堪比一次模型升级 | 与 Harness² **独立印证**"外壳比模型重要"；对外表述可用 |
| **Voting with the Graph** | LLM judge 的**偏好环率 5–9%**；CIR 指标可量化噪声，传递性可去噪 | `briefs/0005` 开放问题 2：judge 可信度按 CIR 量化，超标就不许当兜底 |

**边界**：Python 生态、需要模型调用、50+ 评分器大半（多模态、代码语法）与我们无关。**借方法，不引入依赖。**

**顺带看到的一处文档腐烂**：OpenJudge README 里那篇论文的标题还是旧名 *"Taming the Judge"*，arXiv 上已经改成
*Voting with the Graph*。连一个大项目的 README 都会滞后——所以本仓库的那几条检查（断链 / 索引 / 时间炸弹）方向是对的。

---

## 2026-10 新增：Claw-Eval / Claw-Eval-Live（PKU + HKU）

- 基准：[claw-eval/claw-eval](https://github.com/claw-eval/claw-eval)（MIT）· [论文](https://arxiv.org/abs/2604.06132) · 300 人工验证任务 / 2,159 条 rubric
- 活基准：[Claw-Eval-Live](https://arxiv.org/abs/2604.28139) · 105 个任务，从公开需求信号刷新

一句话：**它解决的是"怎么证明它每次都行"，而不是"它行不行"。**

| 来源 | 原则 | 用在哪 |
|---|---|---|
| **Claw-Eval** | **`Pass@k` ≠ `Pass^k`**：k 次里有一次成功 = 能力；k 次全成功 = 一致性。错误注入下 `Pass@3` 稳定，`Pass^3` 掉 24pp | `briefs/0005` 主指标改成 `Pass^k`；S1 判据 1"不用重复说"本质就是一致性 |
| **Claw-Eval** | **轨迹不透明评测不可靠**：只评最终回答会漏掉 44% 的安全问题、13% 的鲁棒性失败 | `briefs/0005` 需求：评分必须追到三通道证据 |
| **Claw-Eval** | **确定性检查优先，judge 只判语义维度**（证据足够时不用 judge） | `briefs/0005` 断言分层：judge 不是"尽量少用"，是"证据不足才用" |
| **Claw-Eval-Live** | **活基准 = 可刷新的信号层 + 带时间戳的可复现快照** | 我们的黄金集是快照（防回归），真实使用是信号层（防拟合）。soulkernel 的 dev/holdout 都是作者写的，正缺这层 |
| **Claw-Eval** | 能力是多维的，模型排名随任务组和指标变化 | 不要用单一总分对外表述 |

**三通道证据，我们其实都有**：执行轨迹 = `context().used`；审计日志 = `plugin.log`；环境快照 = `memories` 表快照。
缺的不是数据，是**把它们组织成"评测证据"**。

**边界**：300 个任务、多模态、Docker 沙箱、OpenRouter key——都是给前沿模型排名用的，与"注入有没有用"无关。借口径，不借任务集。

---

## 2026-11 新增：遗忘曲线与检索（对我们"怎么忘、怎么想起来"的直接输入）

用户提出：先看文献再设计 soul 的记忆。以下四条是结论、来源，以及**对我们哪一列有影响**。

| 来源 | 结论 | 对我们的影响 |
|---|---|---|
| **Ebbinghaus（1885）遗忘曲线**；[Murre & Dros 2015 复核](https://www.sciencedirect.com/science/article/abs/pii/S0022249610001100) | 遗忘前快后慢，近似指数衰减；复核后曲线带一个很小的初始平台，不是纯指数 | 我们目前**没有衰减**：`vividness` 恒为 1，`recall_count` 不参与评分。要加衰减，起点应是**上次被召回的时间**，不是创建时间 |
| **间距效应 / 间隔重复**（SM-2、Anki；[spaced learning 综述](https://www.aorn.org/the-stitch/article/spaced-learning)） | 每次成功回忆会拉长下一次的间隔；失败则回退。回忆比重读更有效 | `touch()` 现在只做 `recall_count++`，没有"稳定性"概念。间距模型要求：召回 → 间隔变长 → 衰减更慢 |
| **Generative Agents**（Park et al. 2023，[检索机制笔记](https://github.com/curiositech/windags-skills/blob/main/skills/park-2023-generative-agents/references/memory-retrieval-as-attention-mechanism.md)） | 检索分 = 新近度（约 0.995^小时）+ 重要度 + 相关性，三者加权 | 与 [briefs/0007](briefs/0007-retrieval-scoring.md) 的三因子方向一致。我们缺的是**新近度的指数衰减**和重要度的校准 |
| **[写时重要度不等于未来有用](https://zenodo.org/records/22868532)** | 写时打的重要度只反映"当时显著"，不能当"未来会被需要"的先验 | 不要把 `importance` 当固定先验。我们的 `recall_count` / 纠正反馈应当能反过来调整它 |

### 采纳 / 不采纳

**采纳（MVP1 之后，S3）**
1. 新近度用 `last_recalled_at` 的指数衰减（0.995/小时量级起步，可配）
2. `touch()` 同时更新"间隔"，形成间距效应
3. `importance` 允许被使用反馈修正

**不采纳（现在）**
- 检索诱发遗忘 / 多样性重排（MMR）：相似记忆互相抑制是真实效应，但会牺牲召回率，等有数据再说
- 硬删除过期记忆：文献里的"遗忘"是**可及性下降**，不是删除。我们已有 `validUntil` 做失效，不做物理删

**存疑**
- 写时 `importance` 的权重：文献支持它，但也有批评（上表第四条）。先保留，用数据校准。

---

## 使用规则

1. **原则可以引用，数字不要引用。**
2. 任何"因为某篇文章说…"的设计决定，必须在 ADR 里写清**适用的前提**；前提变了就重评。
3. 新增参考资料时，在本文件加一行，写明：原则 / 用在哪 / 是否过期。
