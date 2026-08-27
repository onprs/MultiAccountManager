# Account Vault 代理指南

## 项目基线

- 线上代码仓库：https://github.com/onprs/MultiAccountManager.git（remote: `origin`）；推送前必须确认 `.gitignore` 已覆盖全部凭据与密钥，禁止将 `runtime.enc`、`.env*`、Setup Token、Config Master Key 等隐私内容提交或推送。
- 当前线上目标仅为 `sub2api_tokyo`；未经明确指示，不操作其他线上实例。
- 项目基于 Next.js 16 App Router、React 19、TypeScript、PostgreSQL 14+、Node.js 22.22.2 和 pnpm 11.13.1。
- Web 与 `pg-boss` Worker 由同一个 Linux supervisor 管理，不拆分为独立容器。

## 安全边界

- 用户保险库与服务集成凭据是两个独立安全域，禁止混用密钥或加密材料。
- 保险库明文、主密码、Vault Root Key、TOTP Secret、恢复码和 OTP 只能存在于浏览器 Crypto Worker 中；服务端只接收版本化密文信封。
- 数据库凭据、Better Auth Secret 和服务加密密钥只能写入加密的 `runtime.enc`；Sub2API Observer Token 必须使用独立服务密钥加密。
- 禁止将任何凭据或密钥写入 Git、日志、`NEXT_PUBLIC_*` 或生产环境变量。Setup Token 与 Config Master Key 只通过受限文件挂载。

## 代码约束

- `src/app/api` 仅负责 HTTP 适配；数据库访问、鉴权和领域逻辑放在 `src/server`。
- Setup 路由必须在数据库和认证单例尚未初始化时可用。
- 浏览器密码学逻辑放在 `src/crypto`，运行时配置与 supervisor 放在 `src/runtime`，后台任务放在 `src/worker` 与 `src/server/jobs`。
- 禁止在源码中写死公开域名、WebAuthn Origin、RP ID 或 Sub2API Base URL；域名迁移必须更新受验证的运行时配置，不得信任请求头动态推导身份。
- 已发布迁移不可修改；新增迁移使用下一个编号，并保持校验和迁移流程有效。
- 保持依赖版本固定，修改依赖时同步提交 `pnpm-lock.yaml`。

## 验证与发布

- 提交前运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`；涉及浏览器流程时运行对应 Playwright 测试。
- 生产发布遵循 `deploy/1panel/README.md`，且必须通过 `deploy/1panel/verify-runtime.sh` 的基线检查。
