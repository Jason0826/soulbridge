# 实体池清理候选（只读提案，未改动数据）

共 77 个实体；以下是按规则挑出来的候选，**等你确认后再动**。

## 1. 同名但类型不同（可能是同一个人/物被记成两类）

- 无

## 2. 名字像句子（长度 >12 或含“的/和/与”）

- dsh-plugin-soulbridge · thing · 19 次
- house-plan-designer · thing · 6 次
- restart-dsh.ps1 · thing · 6 次
- soulbridge core · thing · 6 次
- restart-web.ps1 · thing · 4 次
- config/domains.ts · thing · 2 次
- dsh-cookie-guard · thing · 2 次
- video-notes.py · thing · 2 次
- DshRestartOnce · thing · 1 次
- docs/rules.md · thing · 1 次
- docs/steering-project-principles.md · thing · 1 次
- dsh-superagent-prototype · thing · 1 次
- npm_token.txt · thing · 1 次
- turns.test.ts · thing · 1 次
- 尧蔺的抖音视频 · thing · 1 次
- 0024 重排 brief · thing · 0 次
- D:\DSH\home\profiles\web · thing · 0 次
- D:\Media\Ref\燃尽20亿token后，我的大肥鱼像人得可怕 · thing · 0 次
- GitHub Actions · thing · 0 次
- docs/audit/2026-11-03-afternoon-review.md · thing · 0 次
- docs/spec/storage.v0.md · thing · 0 次
- pre-commit 钩子 · thing · 0 次
- prompts.generated.ts · thing · 0 次
- roles.test.ts · thing · 0 次
- scripts/migrate-roles.mjs · thing · 0 次
- vocabulary.v1.md · thing · 0 次
- 小凌的创造者 · person · 0 次
- 送小凌的第二份礼物识海工程拆解 · thing · 0 次

## 3. 提及次数最多（先看这些值不值得留）

- 用户 · person · 42 次
- dsh-plugin-soulbridge · thing · 19 次
- 助手 · self · 19 次
- house-plan-designer · thing · 6 次
- restart-dsh.ps1 · thing · 6 次
- soulbridge core · thing · 6 次
- dsh-desktop · thing · 5 次
- turn_pairs · thing · 5 次
- npm · thing · 4 次
- restart-web.ps1 · thing · 4 次
- DshWebHost · thing · 3 次
- PowerShell · thing · 3 次
- dsh web · thing · 3 次
- dsh-wechat · thing · 3 次
- edit · thing · 3 次
- soul · thing · 3 次
- soul.db · thing · 3 次
- 故障问题分析系统 · thing · 3 次
- 艾宾浩斯遗忘曲线 · thing · 3 次
- 079d · thing · 2 次

## 判定标准（我的建议）

| 情况 | 处理 |
|---|---|
| 同一个人的名字/别名分裂 | 合并到提及最多的一条，别名并集 |
| 术语被当成实体（"注入""结论"） | 删除实体，槽位里的引用改文字；术语不进实体池 |
| 名字是句子 | 删除或改成一个短名词，槽位指向它的事实保留 |
| 只是很久没提 | 不删。实体是身份不是热度，删了历史事实会失去主语 |
