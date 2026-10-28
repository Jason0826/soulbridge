# spec/affect.v0 — 情感分析契约

- 版本：0.1（协议版本 0.2）
- 关联：ADR 0012–0017、`docs/rfcs/0002-affect.md`

本文是测试的依据：每个公式、每条规则、每个阈值都应有对应测试。

---

## 1. `lexicon.v1.json`

```json
{
  "version": "1.0",
  "lang": "zh",
  "entries": { "开心": { "category": "joy", "intensity": 5, "polarity": "positive" } },
  "fillers": ["嗯", "那个"],
  "hedges": ["可能", "我觉得"],
  "vague": { "开心": ["欣喜", "雀跃"] },
  "degree": { "weak": ["有点"], "medium": ["比较", "很"], "strong": ["非常"], "extreme": ["极度"] }
}
```

- `category` ∈ `joy|anger|sadness|fear|disgust|surprise`
- `intensity` ∈ 1..9，`polarity` ∈ `positive|negative|neutral`
- 加载优先级：`--lexicon <path>` > `SOULBRIDGE_AFFECT_LEXICON` > 内置种子表
- 校验失败 → 回退种子表 + stderr 警告，**不阻塞**（`validateLexicon`）

---

## 2. 规则（8 条，ADR 0016 预算）

| id | 规则 | 细节 |
|---|---|---|
| R1 | 字典命中 | 最大正向匹配，最长 6；标点/空白/符号为分隔 |
| R2 | 否定 | 命中词前 **3** 个 token 内出现 `不/没/别/无/未/不是/没有/不再/不用/不太` → 极性翻转、强度 ×0.8；已有情感词则中断 |
| R3 | 程度 | 前 **2** 个 token 内的程度词：弱 −1 / 中 +1 / 强 +2 / 极 +3，clamp 1..9 |
| R4 | 标点 | `!!`、`??`、`……` 每处 emphasis+1，arousal +0.1 |
| R5 | 重复字符 | `(.)\1{2,}` 每处 emphasis+1；有命中时强度 +min(2, emphasis) |
| R6 | 弃权词 | `行吧/随便/算了/随你/都行/无所谓/你定/看着办/再说吧`：`abstain=true`，confidence ≤0.5，不注入 |
| R7 | 代码围栏 | ` ```...``` ` 整段跳过；`$ ` 开头的行跳过 |
| R8 | 极短句 | token ≤3 时 confidence ×0.5 |

**极性翻转规则**（R2）：`positive → negative`，`negative → neutral`。
"不开心"是负向；"不生气"是中性（不是正向）——这是刻意的简化。

---

## 3. 聚合

```
dominant = 各类别强度之和最大者（并列取先出现）
intensity = max(hit.intensity)，无命中为 0；有 emphasis 时 +min(2, emphasis)，clamp 9
valence = Σ(sign × intensity) / Σ(intensity)，sign = +1/0/−1
arousal = min(1, intensity/9 + 0.1 × emphasis)
```

## 4. 置信度

```
hits = 0                     → confidence = 0
否则：
  confidence = 0.40 × min(1, hits/2)
             + 0.20 × min(1, tokens/20)
             + 0.25 × (dominant ? 1 : 0)
             + 0.15 × (intensity/9)
  若 tokens ≤ 3 → ×0.5
  若 abstain    → min(0.5)
```

**为什么短文本要罚**：3 个 token 的"有点烦"不足以支撑一次注入。

---

## 5. 注入（ADR 0014）

```
门槛：confidence ≥ 0.60 且 hits ≥ 1
条数：≤ 2
预算：160 字符；放不下整段丢弃
格式：<affect confidence="0.67" analyzer="lexicon">…</affect>
```

| id | 触发条件 | 文本 |
|---|---|---|
| `negative_high` | valence ≤ −0.4 且 intensity ≥ 6 | 对方情绪偏负面：先承接，再给方案；不要急着讲道理 |
| `positive_high` | valence ≥ 0.4 且 intensity ≥ 6 | 对方情绪偏正面：回答可以更简短 |
| `hedging` | hedges ≥2 且 ≥6/百 token | 对方表达里犹豫词偏多：给结论，少加限定语 |
| `fragmented` | fillers ≥3 且 ≥8/百 token | 对方表达较碎片：先复述你的理解，再回答 |
| `vague_terms` | vague ≥3 | 对方用词较笼统：必要时确认具体所指 |

---

## 6. 采样（不是日志）

```sql
affect_samples(soul_id, user_id, at, analyzer, dominant, intensity, valence,
               arousal, confidence, payload, device_id)
```

- `payload` 是完整 `AffectSignal`（含 hits），**不含原句**
- 保留 30 天，写入时顺带清理
- 唯一索引 `(soul_id, user_id, at, analyzer)` 保证导入幂等

---

## 7. 黄金集与验证

| 项 | 值 |
|---|---|
| dev | 40 条（`test/fixtures/affect-dev.ts`） |
| holdout | 20 条（`test/fixtures/affect-holdout.ts`） |
| 基础桶 | explicit / negation / degree / punctuation |
| 阈值 | dev ≥95%、holdout ≥90%、整体 ≥80%、差距 ≤10 点 |

**当前结果（v0.4）**：dev 100%、holdout 100%、差距 0 点。
**必须说明**：两个 split 都由作者编写，只能防"边改边看"，防不了"同一作者拟合"。P3 要用真实转写补测。

---

## 8. 消融（dev，40 条）

| 规则 | 去掉后 | 差值 |
|---|---|---|
| R1 lexicon | 几乎全错 | ≈ −90pp |
| R2 negation | 7 条否定全错 | ≈ −17pp |
| R3 degree | 6 条程度全错 | ≈ −15pp |
| R4 punctuation | "恼火……" 降 1 档 | ≈ −2.5pp |
| R5 repetition | "崩溃崩溃崩溃" 强度不足 | ≈ −2.5pp |
| R6 abstain | 4 条弃权全错 | ≈ −10pp |
| R7 code-fence | 黄金集无关；由 T4 单独覆盖 | 0（护栏规则） |
| R8 short-input | 黄金集无关；由 confidence 测试覆盖 | 0（护栏规则） |

护栏规则不参与"贡献≈0就删"的判断，但它们必须有自己的测试——否则就是没有指标的防御。
