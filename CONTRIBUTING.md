# 贡献指南

## 环境要求

- Node.js 22.22.2
- pnpm 11.13.1（通过 Corepack 使用）
- PostgreSQL 14 及以上；涉及完整通行密钥流程时建议使用 PostgreSQL 16

安装依赖时必须保留锁文件约束：

```bash
corepack pnpm install --frozen-lockfile
```

涉及浏览器测试时，首次运行前安装 Chromium：

```bash
corepack pnpm exec playwright install chromium
```

## 开发约束

- `src/app/api` 只负责 HTTP 适配，数据库访问、鉴权和领域逻辑放在 `src/server`。
- 浏览器密码学放在 `src/crypto`，运行时配置与 supervisor 放在 `src/runtime`，后台任务放在 `src/worker` 与 `src/server/jobs`。
- 主密码只可由当前页面输入并直接传给浏览器 Crypto Worker，不得持久化；保险库根密钥不得离开 Worker，保险库记录加解密和 TOTP 计算必须在 Worker 中完成。
- 账号明文、恢复密钥、恢复码和派生验证码只可按当前页面的展示、编辑或复制需求短暂返回，不得发送服务端、写入 Web Storage、IndexedDB 或日志；恢复密钥仅可在用户主动下载恢复套件时写入所选文件。
- 用户保险库与服务集成凭据是独立安全域，不得共用密钥或加密材料。
- 不得在源码、日志、`NEXT_PUBLIC_*` 或 Git 中写入生产凭据、真实密钥、真实邮件、数据库文件或运行时密文。明确标记的本地开发与隔离 CI 测试凭据不得在共享或生产环境复用。
- 不修改已发布迁移；新增迁移使用下一个编号，并保持迁移校验和流程有效。
- 依赖版本保持精确固定；修改依赖时同步提交 `pnpm-lock.yaml`。
- 用户界面默认使用简体中文。产品名、协议名和无法准确翻译的技术标识可保留英文，其他术语优先使用统一中文表述。

## 提交前检查

日常开发可运行聚合检查：

```bash
corepack pnpm check
```

提交前至少运行：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

涉及浏览器交互、加密流程或用户可见文案时，补充运行：

```bash
corepack pnpm test:e2e
```

完整通行密钥场景与 Worker 运行时冒烟测试由 GitHub Actions 在隔离的 PostgreSQL 和运行时密钥环境中执行，通行密钥场景另使用 Chromium 虚拟认证器。一次性初始化测试不允许依赖重试恢复状态。

## 提交卫生

提交前检查：

```bash
git status --short
git diff --check
git diff --cached --name-only
```

确认暂存内容不包含 `.runtime*`、`.env*`、`runtime.enc`、Setup Token、Config Master Key、证书、日志、数据库、浏览器测试产物或真实账号数据。发现安全问题时不要提交公开 Issue，按 [SECURITY.md](./SECURITY.md) 处理。
