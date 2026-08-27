# Account Vault

> English version: [README.en.md](./README.en.md)

Account Vault 是一个内部 Next.js 应用，用于 AI 账号记录的加密保管，以及对 Sub2API 状态的按作用域观察和关联账号删除。浏览器端保险库与 Sub2API 服务凭据属于两个独立的安全域。

应用可在无数据库的情况下启动，通过 `/setup` 校验现有 PostgreSQL 实例，执行带校验和的迁移，并写入经认证加密的 `runtime.enc`。Setup 会创建唯一所有者，并在不使用临时密码的前提下完成经用户验证的 Passkey 注册，随后要求浏览器端完成 Vault 初始化与恢复套件（Recovery Kit）确认，应用才会进入 READY 状态。安全设置支持命名备份凭据、会话绑定的 Passkey 提权，以及事务性的最后凭据删除保护。

Vault Root Key 包装、账号记录加密、盲索引、Argon2id、XChaCha20-Poly1305 与 TOTP 生成均在同源的独立 Crypto Worker 中运行；服务端对敏感账号字段只接收带版本的密文信封。账号工作区支持加密的创建/编辑/归档/删除、分页的服务端读取与筛选、邮箱精确盲索引查找、本地 `otpauth://totp`/Base32/图片导入、2FAuth schema-1 JSON 迁移、带服务器时钟校验的 OTP 自动刷新显示/复制，以及 Passkey 门控的恢复码显示/复制。

Sub2API 连接使用专用的 `account_observer:read account_observer:delete` Token。Token 与所有者和连接绑定，使用独立的服务端 XChaCha 密钥环加密，绝不使用 Vault Root Key。`/connections` 工作区会校验实例身份与时钟偏差，支持按唯一邮箱自动关联 OpenAI/ClinePass 及手动关联，并展示归一化的健康状态、已存储配额窗口、同步新鲜度、Worker 心跳与去重后的应用内告警。删除关联的托管账号时，会先通过按作用域的集成端点删除其 Sub2API 账号；远端删除失败时保留本地账号，以便幂等重试。由 supervisor 管理的 `pg-boss` Worker 按连接运行唯一任务，仅重试瞬时故障，保留最后一次有效快照，并随 Web 进程优雅关闭。

## 技术栈

- Node.js 22.22.2 生产基线
- pnpm 11.13.1
- Next.js 16.2.10 / React 19.2.4
- PostgreSQL 14 及以上

## 本地验证

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
```

本地 Setup 模式需要创建 `.runtime/account-vault-setup-token` 与 `.runtime/account-vault-config-key`。Setup Token 为文本；Config Key 必须是恰好 32 字节的随机数，或 32 字节随机数的 43 字符 base64url 编码。`.runtime` 已被 Git 忽略。

启动应用：

```bash
corepack pnpm dev
```

打开 `http://localhost:3000/setup`。动态页面与 API 响应均为 `no-store`；运行时密钥绝不可放入 `NEXT_PUBLIC_*` 变量。CSP 允许 `wasm-unsafe-eval` 仅因 Argon2id/libsodium 需要编译 WebAssembly；JavaScript 的 `unsafe-eval` 仍然禁用。

常规 Playwright 套件无需 PostgreSQL，并会跳过完整的 Passkey 场景。CI 提供 PostgreSQL 16，运行迁移、虚拟认证器的所有者引导/登录、Vault 初始化、恢复套件确认、加密账号创建与 TOTP 校验。

部署要求与当前 1Panel 门禁见 `deploy/1panel/README.md`。实现进度见 `docs/IMPLEMENTATION_STATUS.md`。
