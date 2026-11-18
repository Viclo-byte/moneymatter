# MoneyMatter 简体中文自托管版

本站：https://money.topeggs.win  
MCP：https://money.topeggs.win/mcp  
官方稳定分支：`letehaha/moneymatter:main`。

## 中文与更新

保留官方原有中文，补齐其余界面及后端错误信息，人工校订常用操作、记账术语和授权界面。新增简体中文语言选项、中文日期格式、中文浏览器语言识别。首版补全后已按界面与业务逻辑校订 2,784 条文案，修正账户、预算、贷款、投资、退款和安全提示等语境用词。后续修改遵循 [中文用语规范](zh-CN-style-guide.md)；品牌、代码、币种及可解析的输入示例保留必要的英文。此 Fork 的翻译独立于 Crowdin 的审核状态。

运行 `node scripts/check-chinese.mjs` 检查翻译键、插值变量、复数分支及前端消息语法；运行 `npm run typecheck` 和前后端构建验证集成。

已配置每周一及手动触发的 `Sync official stable updates` 工作流。它把官方 `main` 合并到 `sync/official-stable` 并创建发往本 Fork 的 PR，保留中文改动，不会自动覆盖生产。Fork 首次使用需启用 Actions，并允许工作流创建 PR。发生合并冲突时工作流会失败，需要处理后重试。

新增英文键由英文回退保障显示；部署前应补齐中文并运行检查。依赖更新后应同步更新中文轻量镜像所依赖的官方镜像摘要，核对 `package-lock.json`。官方完整源码构建方式仍为 `self-hosting/docker-compose.build.yml`。

## 2GB 服务器的部署方式

在较大内存的机器上执行 `npm ci`，然后：

```sh
node scripts/check-chinese.mjs
NODE_OPTIONS=--max-old-space-size=6144 npm run build -w packages/frontend
npm run build -w packages/backend
mkdir -p release/frontend-dist release/backend-dist
cp -R packages/frontend/dist/. release/frontend-dist/
cp -R packages/backend/dist/. release/backend-dist/
cp self-hosting/chinese/Dockerfile.* release/
```

将 `release/`、`self-hosting/docker-compose.yml` 和 `self-hosting/chinese/compose.chinese.yml` 放到服务器 `/opt/moneymatter/`。`.env` 只在服务器生成，不提交到 GitHub。执行：

```sh
cd /opt/moneymatter
docker compose -f docker-compose.yml -f compose.chinese.yml up -d --build
```

前端和后端使用 Docker 中的中文构建产物；官方基础镜像按摘要固定，避免未验证的更新。数据库、Redis、汇率服务仅在 Docker 内部网络可达，网站入口只绑定 `127.0.0.1:5008`，由 OpenResty 提供 HTTPS。首次数据库初始化可能需要十多分钟。

环境变量包括 `BETTER_AUTH_URL`、`AUTH_ORIGIN` 和 `MCP_BASE_URL` 均为 `https://money.topeggs.win`，`AUTH_RP_ID=money.topeggs.win`，`SYSTEM_MAX_SIGNUPS_ALLOWED=1`。注册首个账户后关闭后续注册。

## MCP

在 ChatGPT 的自定义 MCP 配置中使用 `https://money.topeggs.win/mcp`，选择 OAuth，登录本站后选择授权范围及工具集。为保持工具数兼容，先启用日常记账核心工具。读写和永久删除为不同权限，按实际需要授权。可在本站“设置 → AI 集成”撤销连接。

本站维护 AGPL-3.0 授权，完整中文修改源码公开于本 Fork。账户口令、Cookie 和服务器密钥不包含在本仓库中。

## v0.33.18 更新

已合并官方正式标签 v0.33.18（216d26e6885c706a2b98b27755e071d5d95dfb2b），保留中文校订，并补齐“显示收付款方图标”等新增文案。此版 package-lock 只变更前端版本号，运行依赖未变，继续使用已固定的官方基础镜像。没有新增数据库迁移。
