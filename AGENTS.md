# Account Vault 代理指南

## 项目基线

- 代码仓库：https://github.com/onprs/MultiAccountManager.git（remote: `origin`）。凭据与密钥文件（如 `runtime.enc`、`.env*`、Setup Token、Config Master Key 等）由 `.gitignore` 排除，保持版本库纯净。
- 当前线上维护目标为 `sub2api_tokyo`。其他线上实例仅在有明确操作要求时处理。
- 技术基准：Next.js 16 App Router、React 19、TypeScript、PostgreSQL 14+、Node.js 24.22.1 与 pnpm 11.13.1。
- 进程架构：Web 进程与 `pg-boss` Worker 由统一的 Linux supervisor 管理，采用单容器部署。

## 安全与凭据模型

- 域隔离：用户保险库数据与第三方服务集成凭据采用独立的密钥材料与加密通道。
- 客户端密码域：主密码、Vault Root Key、明文凭据、TOTP Secret、恢复码及一次性口令的生命周期收敛于浏览器 Crypto Worker 内存；服务端仅处理版本化密文信封与盲索引。
- 服务端密钥域：Sub2API Observer Token 等服务集成凭据由独立的服务密钥环加密存储。
- 运行时凭据：数据库凭据、Better Auth Secret 及服务主密钥持久化于加密的 `runtime.enc`；Setup Token 与 Config Master Key 通过受限权限的文件挂载提供，与源码、构建产物、日志及生产环境变量隔离。

## 架构与代码组织

- 职责分层：
  - `src/app/api`：负责 HTTP 请求接入、参数校验与协议适配。
  - `src/server`：承载领域业务逻辑、鉴权控制及数据库访问。
  - `src/crypto`：负责客户端加密算法、密钥派生及 Worker 通信。
  - `src/runtime`：负责运行时配置解析、文件解密与 supervisor 进程管理。
  - `src/worker` 与 `src/server/jobs`：处理异步后台任务与作业编排。
- 引导生命周期：Setup 路由在数据库连接和认证单例初始化完成前保持可用。
- 身份与域名：公开域名、WebAuthn Origin、RP ID 及 Sub2API 服务地址依赖经过验证的运行时配置，不依赖客户端请求头动态推导。
- 数据库演进：已发布的数据库迁移保持不可变；新增结构调整使用下一个递增编号，并同步维护迁移校验和机制。
- 依赖管理：项目依赖版本精确锁定，更新依赖时同步提交 `pnpm-lock.yaml`。

## 质量验证

- 常规检查：提交前执行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与 `pnpm build`。
- 交互验证：涉及浏览器认证与加密流程的变更，补充运行对应 Playwright 端到端测试。
- 部署验收：生产交付遵循 `deploy/1panel/README.md`，并通过 `deploy/1panel/verify-runtime.sh` 脚本校验。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
