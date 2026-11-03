# 发布与维护手册

> 这份文档记录**怎么做**，以及**哪些事还没做**。改流程请同步改这里。

---

## 一、CI / CD 现状

| 环节 | 状态 | 位置 |
|---|---|---|
| **CI**（push / PR 跑类型检查、构建、测试、安装冒烟） | ✅ 已建 | `.github/workflows/ci.yml` |
| **CD**（推 tag 自动发布 npm） | ✅ 已建并验证 | `.github/workflows/release.yml` |
| 认证方式 | npm Trusted Publishing（GitHub OIDC），**不用 token** | npm 包设置里已绑定 |
| 发布后人工审批 | ❌ 不需要（npm 只做异步扫描） | —— |

已验证的发布：`0.0.1`（坏的）、`0.0.2`（修复）、`0.0.3`（OIDC 首发）、`0.0.4`–`0.0.6`（affect 层、库入口）。

---

## 二、发版流程（4 步）

### 第 0 步：闸门（不绿不 tag）

**打 tag 之前必须跑完并贴出结果**，任何一条红都不允许进第 1 步：

```bash
npm run typecheck && npm test          # core：期望 fail 0
cd ../dsh-plugin-soulbridge && node --test test/index.test.mjs   # 插件：期望 fail 0
```

这条是 2026-10-29 的教训：插件 0.0.26、0.0.27 在测试红着的情况下被发布，
原因是「改测试被工具拒绝」被当成了「改好了」。**看到 `fail 0` 才算过。**

### 第 0.5 步：装完必须用**安装后的产物**断言

源码绿 + 版本号对，**不代表装上去的东西是对的**。2026-11-01 一天踩了四次：

| 表面 | 实际 |
|---|---|
| 长度守卫改了 | core 里还有一份同源守卫 |
| 插件装好了 | `dist/prompts.js` 没复制，import 失败，插件根本没加载 |
| 版本号 0.0.34 | pnpm 用了缓存副本，dist 是旧的 |
| 加了 `includeAnchors` 开关 | `Soul.context()` 手写字段清单把它吞了 |

四条都没有被版本号或源码检查发现。所以装完 / 重启后**必须**跑：

```bash
node --experimental-strip-types scripts/verify-installed.mjs [profileDir]
# 默认 profileDir = ~/.dsh/profiles/desktop
# 期望最后一行：all checks passed against the installed artifacts
```

它断言的是安装副本自身的行为：core/plugin 版本、dist 入口存在、section 不含锚点、
锚点可单独取、抽取 prompt 能渲染、插件能 `import` 出 `apply()`。

> **验收口径**：不看"我改了什么"，看"装上的是什么"。任何一次改动，如果没有一条
> 针对安装产物的断言，就当作没改。

### 第 0.6 步：发版前看一次质量比率

```bash
node scripts/quality.mjs --days 7
```

四项比率（[ADR 0031](adr/0031-model-dependency-acceptance.md)）：事实密度、抽取走模型比例、
结论支持率、情绪非零率。**任一 FAIL 要在发布记录里写明原因**，不许"感觉还行"就发。

脚本还会列出规则兜底的分布——`model-failed` 和"主动选择规则模式"是两种完全不同的问题，
一个笼统的比率会把它们混在一起。

```bash
# 1. 升版本（不动 git tag）
npm version patch --no-git-tag-version

# 2. 提交并打 tag
git add -A && git commit -m "chore: <版本> — <一句话>"
git tag -a v0.0.x -m "soulbridge 0.0.x"
git push origin main
git push origin v0.0.x
```

3. 等 GitHub Actions 跑完（约 30 秒）
4. **等几分钟**再验证 —— npm 现在是异步扫描，刚发完不会立刻可见

```bash
npm view soulbridge version        # 期望新版本号
npm view soulbridge dist-tags      # latest 是否跟上
```

> ⚠️ 不要因为「注册表暂时 404」就判定发布失败。这是扫描队列，不是错误。

### 发布后验证（用户视角）

```bash
mkdir /tmp/verify && cd /tmp/verify
npm init -y
npm i soulbridge
npx soulbridge stats
```

---

## 三、维护操作（需要本机 npm 凭证）

发版用 OIDC，但**维护操作不支持 OIDC**：弃用、改 dist-tag、取消发布，都需要登录。

```powershell
npm login     # 浏览器 + Windows Hello，凭证存到 ~/.npmrc
```

### 弃用某个版本

```bash
npm deprecate "soulbridge@0.0.1" "原因写这里"
```

校验：

```bash
npm view soulbridge@0.0.1 deprecated
```

### 改 dist-tag

```bash
npm dist-tag add soulbridge@0.0.3 latest
npm dist-tag ls soulbridge
```

---

## 四、待办（P0）

### 弃用 `0.0.1`

- **为什么**：`0.0.1` 的 `bin` 指向 `.ts` 文件，安装后在 `node_modules` 里无法运行（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。`0.0.2+` 已修复。
- **影响面**：只有显式 `npm i soulbridge@0.0.1` 的人会中招；`latest` 已是 `0.0.3`。
- **命令**：

  ```bash
  npm deprecate "soulbridge@0.0.1" "broken: bin pointed at TypeScript and crashes under node_modules. Use 0.0.2 or later."
  ```

- **状态**：⏳ 未执行（需要先 `npm login`）
- **完成后**：勾掉此项，并把结果记在下面。

### 可能也想做

- [ ] 删除 GitHub 的 `NPM_TOKEN` secret（OIDC 已生效，发布不再需要它）
- [ ] 给仓库加 description 与 topics（当前 `description: null`）
- [ ] 把 npm 账号邮箱从 QQ 邮箱换成别名（注册表元数据里是公开的）

---

## 五、踩过的坑（别再踩）

| 坑 | 教训 |
|---|---|
| 包发上去但装完就崩 | **必须在 `node_modules` 里验证**，解压到临时目录不算数——那会绕过 Node 对 `node_modules` 内 TS 的禁令 |
| 发完立刻 `npm view` 查不到 | npm 是异步扫描，等几分钟；不要急着重发或改版本 |
| `npm publish` 成功但没上线 | 看 `dist-tags`，不要只看命令退出码 |
| 系统级 git 配置把 github.com 重写成 gh-proxy | 用 `https://github.com:443/...` 绕开；SSH 不受影响 |
| 提交里带个人邮箱 | 用 GitHub noreply（已在历史里全部改过） |

---

## 六、v0.4 迁移说明（重要）

- 默认数据库从 `./.soulbridge/soul.db` 移到 **`~/.soulbridge/soul.db`**（跨工具要求同一路径）
- 身份写入 `~/.soulbridge/config.json`（soulId / userId / name / deviceId）
- 旧数据**不会自动搬迁**，需要手动导入：

  ```bash
  # 在旧目录下导出
  SOULBRIDGE_DB=./.soulbridge/soul.db soulbridge export --out old.jsonl
  # 在新库导入
  soulbridge import --in old.jsonl
  ```

- schema v1 → v2 升级会自动备份为 `soul.db.bak-v1`
- 数据库版本高于二进制时会被拒绝（`DB_NEWER_THAN_BINARY`），不会静默写坏

## 七、维护命令速查

| 目的 | 命令 |
|---|---|
| 换机器 | `export --out x.jsonl` → `import --in x.jsonl` |
| 改 soul 身份 | 编辑 `~/.soulbridge/config.json`，或设 `SOULBRIDGE_SOUL` / `SOULBRIDGE_USER` |
| 看情绪分析 | `soulbridge affect "我不太开心"` |
| 用本地小模型分析 | `SOULBRIDGE_AFFECT_LLM_URL=http://localhost:11434/v1 soulbridge affect "..." --analyzer llm` |

## 八、本地 overlay 安装（未发版时怎么上真机）

改了 core 或插件但还没发 npm，要在真机验证时走这条路。**它是一次性的 overlay，不是持久真相。**

profile 位置：`D:\DSH\home\profiles\desktop\node_modules\`（`~/.dsh/profiles/desktop` 指向同一份存储）

```
1. soulbridge 里 npm run build            # tsc → dist
2. 备份：把 profile 下两个包目录拷到 node_modules.bak-<时间戳>
3. 替换 core：dist / adapters / package.json / README / LICENSE / NOTICE
   → profile/node_modules/soulbridge
4. 覆盖插件：index.js + package.json → profile/node_modules/dsh-plugin-soulbridge
5. 重启 DSH —— 用 `dsh-plugin-soulbridge/scripts/restart-dsh.ps1`，
   且必须由**计划任务**拉起（app 的 job object 会杀掉从内部启动的脚本）
```

`schtasks` 在 agent 沙箱里不可用，所以第 5 步需要人触发；脚本日志在 `~/.soulbridge/restart.log`。

**验证**（重启后）：

- `plugin.log` 出现 `apply() called (v<插件版本>)`
- 故意说一句纠正话术，日志出现 `correction recorded: <id> layer=structural|rule`
- `soul.db` 的 `corrections` 表出现行（之前一直是 0）

**坑**：在 profile 目录里跑 `npm install`，会按 `package.json` 的 `^0.0.x` 把 core 覆盖回 npm 上的旧版。
overlay 装过之后，任何 `npm install` 都要重新走一遍第 3 步。

**回滚**：把 `node_modules.bak-<时间戳>` 里的两个目录拷回去，再重启。


## 克隆之后（每台机器一次）

```
npm install        # 装依赖
npm run setup      # 安装 pre-commit 钩子（prepare 已移除，见下）
node scripts/install-hooks.mjs --check   # 确认钩子在了
```

为什么 `prepare` 不再做这件事：`prepare` 是**包的生命周期脚本**，从 GitHub/npm 安装时也会跑。
实测 `npm install github:Jason0826/dsh-plugin-soulbridge#v0.0.102` 失败在 `git dep preparation failed`
——因为没有 `.git`，`git config core.hooksPath` 跑不了。仓库便利动作不能放在包里。
钩子仍然不靠记性：`health-check` 会检查它，没装报 WARN。

## 在 profile 里装新版本（pnpm 的三个坑）

2026-11-03 晚踩过，记下来，别重走：

```
① minimumReleaseAge：pnpm 拒绝太新的版本，报 ERR_PNPM_NO_MATCHING_VERSION
   → 在 profile 的 pnpm-workspace.yaml 里加：
     minimumReleaseAgeExclude:
       - soulbridge@0.0.104
       - dsh-plugin-soulbridge@0.0.107
② registry 元数据缓存：pnpm 还说 “latest is 0.0.103”，哪怕 npm 已经有 0.0.104
   → 等一分钟重试；仍不行就用 tarball URL：
     pnpm add https://registry.npmjs.org/soulbridge/-/soulbridge-0.0.104.tgz
   → 装完把 package.json 里的依赖改回 "0.0.104"，再 pnpm install
③ dsh plugin add 是非交互的：需要确认的提示不会出现，直接失败
   → 先改 workspace 配置（①），再重跑
```

装完必须核对**三层**（版本号会骗人）：

```
npm          npm view soulbridge version
profile      node_modules/soulbridge/package.json
运行         plugin.log 里 apply() called (v…) 的时间戳在重启之后
```