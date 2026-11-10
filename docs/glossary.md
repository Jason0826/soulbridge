# 术语表（一处一个意思）

> **谁读**：第一次接手的人；每次改 `packages/core/src/config/*` 的值域之前；`scripts/term-audit.mjs` 报分叉时。
> **什么时候读**：你怀疑"同一个词在两处意思不一样"，或者要新增/改一个枚举值。
>
> 这份文件只做一件事：**把一个词钉在一个意义上，并指出它的唯一声明在哪**。
> 定义本身不在这里展开——在 `config/` 里，在这里只放指针。下面所有"实际"数字来自
> `node scripts/term-audit.mjs`（2026-11-10 20:40 读数）。

## 一、最容易混的三个

| 词 | 它其实是什么 | 不是什么 |
|---|---|---|
| **fact / facts** | `soul.db` 里那张表的名字；一行 = 一个命题 | **不是一个 role 值**。写 `role='fact'` 是错的，库里没有这个值 |
| **事实** | 有三种用法，必须每次说清是哪种：① `facts` 表的一行 ② `type_name='事实'` 的那 35 行 ③ 日常说"真的事" | 前两个是数据，第三个不是术语 |
| **结论** | `type_name='结论'` 的中文标签（17 行）+ 一条伴对你说的话 | 不是 role——它的 role 是 `judgment` |

## 二、结构化字段（有声明的）

| 词 | 唯一声明 | 取值 | 实际（active） | 谁读它 |
|---|---|---|---|---|
| `role` | `config/domains.ts` → `FACT_ROLES` | `observation` `judgment` `rule` `profile` `promise` `lesson` | 831 / 228 / 209 / 68 / 30 / **0** | 路由：observation→检索；judgment→检索+画像输入；rule→触发时注入；profile→每轮注入；promise→承诺跟踪；lesson→规则候选 |
| `status` | `config/domains.ts` → `FACT_STATES` | `raw` `candidate` `active` `retracted` | 2 值（`active` `retracted`） | `isActive()` / `isRetracted()`（`roles.ts`） |
| `holder` | `config/domains.ts` → `HOLDER_WORDS` | `world` `self` | world 828 / self 191 / **实体 id 347** | 按层取；ADR 0032 的两层记忆靠它 |
| `type_name` | **没有声明**（模型自由写） | 任意中文 | **466 个不同值，320 个只出现 1 次** | ADR 0027 之后**不参与路由**，只给人看 |
| `entity.id` | `sqlite.ts:1083` | `en_<type>_<encodeURIComponent(name)>` | — | 引用用；**不给人读**（rule 43：id 与名字分离） |

## 三、已经分叉的地方（三条，都带数）

**① `holder` 有三种说法**

| 出处 | 它说 holder 是什么 |
|---|---|
| `config/domains.ts` `HOLDER_WORDS` | 只有 `world` / `self` |
| `types.ts` 一处注释 | "world or a person's name" |
| `types.ts` 另一处注释 | "world, self, or an entity id (in someone's mind)" |
| 实际数据（`extract.ts:821`） | 名字会解析成 **entity id** 再写进去 |

所以 `term-audit` 报的"holder 出现未声明值"**不是数据错，是声明少了一档**。名字 `HOLDER_WORDS` 暗示全值域，其实只是两个"层词"。改法二选一：声明改成三层（`world` / `self` / `entity_id`），或者把常量改名成 `HOLDER_LAYERS` 并补一档 `entity id`。

**② `type_name` 已经不是分类，是描述**

466 个值里 320 个只出现一次，29 个值横跨多个 role（`结论` 既在 `judgment` 也在 `observation`）。这不是"脏数据"——ADR 0027 之后它本来就不该承担路由。但它**仍然在提示词里被当成标签生成**，于是每轮都在制造新的近似同义词。

**③ 声明了但库里 0 条**

`role=lesson`、`status=raw` / `candidate`。三者都是"为将来留的档"，不是 bug；但**任何"扫描未使用值"的检查如果不排除它们，就会永久误报**——这就是为什么 §三①的修法要先于接线。

## 四、还没有定名的概念（0030 的，暂不进表）

`场合`、`倾向`、`成熟度`、`注入点`、`缺席`——这五个词现在只在 [briefs/0030](briefs/0030-situated-disposition.md) 里有定义，代码里一行都没有。**等第 0 步落地 `config/situation.json` 时，它们才进这张表**，否则就是给还没实现的东西发编号。

## 五、机器检查

```
node scripts/term-audit.mjs          # 对照 config 声明与库里实际值
exit 1 = 库里出现了 config 没声明的值（真分叉，当前会红：holder）
```

只做对照，不做判断：它不知道"实体 id 该不该算 holder"，只把差异摆出来。**该不该改是人的决定，改完把声明补上，红就自然消失了。**

## 相关

- 值域的唯一声明：[config/domains.ts](../packages/core/src/config/domains.ts)
- 为什么 role 和 type_name 分开：[ADR 0027](adr/0027-code-vs-model-boundary.md) · [ADR 0033](adr/0033-rules-profile-memory.md)
- holder 两层：[ADR 0032](adr/0032-two-layers-of-memory.md)
