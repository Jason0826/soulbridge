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

已验证的发布：`0.0.1`（坏的）、`0.0.2`（修复）、`0.0.3`（OIDC 首发）。

---

## 二、发版流程（4 步）

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
