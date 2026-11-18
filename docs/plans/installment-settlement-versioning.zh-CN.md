# 本次分期扩展的 GitHub 版本管理约定

状态：研究阶段。本文记录本次版本策略，不表示已安装远程分支保护规则或已经发布功能。

## 基线与工作分支

- 基线：`b430af3e7ba0af2a5b7f71d3d0223ee03fe4bde7`，保留官方 v0.33.18 与个人中文调整。
- 基线备份分支：`backup/pre-installment-2026-11-18`，指向上述提交，仅作源码追溯，不是数据库备份。
- 研究分支：`docs/installment-settlement-design`，保存原始需求、研究与方案、版本约定，通过草稿 PR 面向 main 审阅。
- 后续实现建议分支：`feat/installment-settlement`；须先得到方案确认，再从当时审核过的基线创建。
- 上游同步单独走既有 `sync/official-stable` PR，不与分期逻辑混为一次提交。

## 提交与审核

本阶段仅提交 `docs/plans/installment-settlement-*.zh-CN.md`。不改源码、migration、依赖版本、工作流或部署配置。

后续实现按可审核的主题提交：金额模型与计划、原子结算、撤销与提前结清、API/MCP、前端和翻译、测试。提交信息用 docs/feat/fix/test 等既有约定，不使用没有对应实现的版本号或发布标签。

提交前检查工作区及 diff，指定文件暂存，不使用无差别全部加入以免混入账单、配置或其他工作。账本、数据库导出、.env 与凭据不进入 Git。禁止强制覆盖 main、改写既有历史或覆盖官方 v\* 标签。

main 的 GitHub 元数据在研究时显示未受保护；本次不把文档约定当成已强制执行的保护。后续如设置远程规则，建议要求 PR、CI 通过并禁止强推；需另行核实 GitHub 管理权限与实际规则结果。

## 检查与发布

现有 `.github/workflows/check-source-code.yml` 提供 lint、单元测试、类型检查、端到端测试及构建等检查。本次文档提交本地只校验格式、链接和 diff；远程检查结果单独如实报告。

实际开发验收至少包括：

- `npm run lint`、`npm run typecheck`。
- 后端 `test:unit`、`test:lint-rules`、独立测试环境 `test:e2e`。
- 前端 `test:unit -- --run` 与相关 Playwright；`node scripts/check-chinese.mjs`。
- `npm run build -w packages/backend` 与 `npm run build -w packages/frontend`。
- 独立数据库迁移、回滚、并发与故障注入；财务验收见研究报告。

现有 `image-to-docker-hub.yml` 可在 main 推送的 CI 成功后进入镜像和部署流程；因此研究 PR 保持草稿，不合并、不触发手动部署、不添加 preview 标签。main 合并不能被当成纯文档归档步骤。

研究阶段不递增产品版本，不创建 Release。功能验收后再制定 Fork 发布号与不可变构建 SHA，保留官方上游版本和个人扩展版本的映射；不要冒用官方未发布版本。发布需单独核对工作流和部署目标，并备份独立的数据库。

## 回退

源码基线分支只能恢复源代码，不能恢复账本。发布前记录应用 SHA、镜像 digest、数据库 migration 状态及备份标识。新模式有实际结算后，应先暂停相关自动任务并审核数据兼容性，通常优先向前修复。不可仅回退容器并删除新增表；不可直接修改账户余额代替撤销交易。

## 阶段记录

1. 2026-11-18：完成需求快照、现有实现研究与待确认设计；业务代码未实施。
2. 待用户确认：本金方向、账户支持边界、跳过/整组结算规则、旧计划转换规则。
3. 待实施与验收：不得将计划清单描述为已通过测试。
