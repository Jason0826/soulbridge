# LongMemEval 检索层基线（2026-10-31）

> 本文只记录**已验证的检索层结果**和**复现方法**。它不是设计文档，
> 也不证明"人格记忆"那套设计有效——那个需要另一套评测（见文末"没测到的"）。

## 1. 为什么用这个数据集

前面的实验（`entity-recall-test/`）用的是自拟 query，结论不可信：
问题是我出的，期望答案也是我定的，调权重等于在自己出的题上作弊。

LongMemEval（ICLR 2025）提供 500 道题，历史会话、问题、答案都由作者标注，
**query 和期望都不由我们决定**。它测的是事实检索，不是人格记忆，但它是目前
唯一能客观复现的尺子。

- 论文：https://arxiv.org/abs/2410.10813
- 仓库：https://github.com/xiaowu0162/longmemeval
- 数据：[`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
  （国内用 `hf-mirror.com` 镜像可下）
- 用 `longmemeval_s_cleaned.json`（264 MB，每题约 40 个历史会话）。
  `oracle` 版只含证据会话，测不了召回；`m` 版 2.6 GB，太大。

## 2. 方法

每轮对话当一条记忆（本轮实验**没有**用抽取/提炼/实体/分层），
用问题的词做检索，看 `has_answer: true` 那一轮有没有进 top-k。

`has_answer` 和 `answer_session_ids` 都是数据集标注字段，不需要人工判。

四个改动分别测过：

| 改动 | 作用 |
|---|---|
| IDF | 让"hotel"这类到处都有的词降权 |
| 停用词过滤 | 去掉 the/a/what 这类无信息词 |
| 助手轮 ×0.5 | 保留助手轮但不平等对待（它会在回复里复述用户的词，污染检索） |
| BM25 / PRF | 测过，见结论 |

## 3. 结果（hold-out 380 题，训练集每类前 20 题未用）

```
asst权重     R@1   R@5  R@10  R@20
0.0(排除)     51    71    78    82
0.3           52    72    81    85
0.4           52    75    83    88
0.5           53    77    84    89
0.6           54    77    83    88
0.7           52    76    81    87
0.8           49    75    78    85
1.0(不加权)    35    67    74    80
```

**助手权重 0.5–0.6 并列最优，0.5 的 R@10/R@20 略高。** 训练集选的 0.5 在未见数据上成立，
不是过拟合。

加上停用词过滤后（换打分实现后重测）：

```
方法              R@1  R@5  R@10  R@20
IDF + 停用词      57   82    85    87
BM25              56   82    86    88   ← 与 IDF 无差异
BM25 + PRF        42   77    84    88   ← 负收益
```

## 4. 结论

- **基线 → 当前：R@5 49% → 82%**（hold-out 实测），全部来自一个改动组合：
  **IDF + 停用词过滤 + 助手轮 ×0.5**。
- **BM25 不比简单 IDF 好**，在这个语料上打分公式不是瓶颈。
- **PRF（伪相关反馈）有害**：R@1 掉 15 点。它从 top-10 里捞词扩查询，
  而 top-10 里大量不相关文档，扩词只是往查询里加噪声。偏好类一点没救（60→60）。
- 残余短板：
  - 偏好类 R@5 约 60，瓶颈是语义（问题问"配件"，答案说"闪光灯"），不是排序。
  - 助手类需要更高权重（0.8 时 86），但会伤其他类，所以 0.5 是全局折中。

## 5. 复现

```powershell
# 数据（约 264 MB）
mkdir D:\git-workspace\repos\_scratch\longmemeval
curl.exe -L -o D:\git-workspace\repos\_scratch\longmemeval\longmemeval_s_cleaned.json `
  "https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"

# 分层抽样 120 题，看各类
python _scratch\longmemeval\retrieve_eval.py 20

# hold-out 380 题，扫助手权重
python _scratch\longmemeval\holdout_test.py

# BM25 / PRF 对比
python _scratch\longmemeval\bm25_prf_test.py
```

## 6. 没测到的（别当成结论）

- **这是 retrieval 指标，不是答题正确率。** 召回对了不等于答对。
- **全英文。** 中文的指代（"她""那个女同事"）和分词都没覆盖。
- **没有用抽取/提炼/实体/分层。** 测的是"纯关键词检索的天花板"，
  不能用来论证那套设计有效或无效。
- **偏好类仍然 60，没解决。**

## 7. 和"伙伴感"的关系

LongMemEval 测"事实检索"，测不了"像不像被了解的伙伴"。后者的候选指标：

| 层 | 指标 | 频率 | 性质 |
|---|---|---|---|
| 客观 | 重复解释次数 | 每天 | 可计数，单被试可用（N-of-1 / ABA 设计） |
| 主观 | 被了解感 3 题（PPR / Felt Understanding 改造） | 每周 | 1–7 分 |
| 检索 | 本文的 82% | 每次改动 | 离线可跑 |

单被试不能做群体统计推断，但可以做 N-of-1 实验看因果，
不能因为 n=1 就说"不能评测"。
