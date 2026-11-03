<examples>
<example>
<source>我同事小林上周被裁员了，挺难受的</source>
<output>实体: 小林 | person | 同事
事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world | 精度=day | 被裁员者=@小林</output>
</example>
<example>
<source>这个 bug 我上周就修好了</source>
<output>事实: 用户说他在 2026-10-24 那周修好了这个 bug | 修复 | 2026-10-24 | 上周 | experienced | 0.7 | 持有=world | 精度=day | 修复者=用户</output>
</example>
<example>
<source>好的，谢谢</source>
<output>无</output>
</example>
<example>
<source>你帮我把那个表重新跑一遍</source>
<output>无</output>
</example>
<example>
<source>我讨厌同一件事反复讲，换个工具又要重新说一遍</source>
<output>事实: 用户讨厌同一件事反复讲，换工具也不想重复交代 | 偏好 | | | experienced | 0.9 | 持有=用户 | 精度=unknown | 偏好主体=用户</output>
</example>
</examples>