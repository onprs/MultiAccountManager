# Account Vault

> English: [README.en.md](./README.en.md)

Account Vault 是面向单一管理员的 AI 账号加密管理工具。它提供账号凭据、TOTP、平台恢复码和 Sub2API 连接状态的统一工作区，并将保险库数据与服务集成凭据隔离在两个独立的安全域中。

## 安全边界

- 主密码只在当前页面输入并传给独立 Crypto Worker，不写入持久化存储；保险库根密钥只存在于 Worker，记录加解密和 TOTP 计算均在其中执行。
- 账号明文、恢复密钥、恢复码和派生验证码仅在当前页面明确需要展示、编辑或复制时从 Worker 返回，不发送到服务端，也不写入 Web Storage 或 IndexedDB；恢复密钥只会在用户主动下载恢复套件时写入所选文件。锁定保险库会卸载工作区并终止 Worker。
- 对于保险库记录，服务端只接收带版本的密文信封、盲索引和必要的非敏感元数据。
- Sub2API 集成令牌属于独立安全域。服务端在通行密钥验证后的连接流程或受限文件预配流程中短暂接收令牌，并立即使用独立服务密钥加密，不会接触保险库根密钥。
- 生产数据库凭据、认证密钥和服务密钥保存在加密的 `runtime.enc` 中，不写入源码、日志或 `NEXT_PUBLIC_*` 环境变量。
- 生产初始化令牌与配置主密钥只通过受限文件挂载。仓库中的固定值仅可作为绑定回环地址的本地开发或隔离 CI 测试凭据，不得在生产环境复用。

## 主要功能

- **安全初始化**：在未连接数据库时启动，通过 `/setup` 验证 PostgreSQL、执行带校验和的迁移，并创建首位管理员。
- **无密码登录**：使用通行密钥注册、登录、提权和管理备用凭据，并保护最后一个通行密钥不被删除。
- **浏览器端保险库**：使用 Argon2id 与 XChaCha20-Poly1305 加密，支持主密码或恢复密钥解锁、恢复套件确认和密钥轮换。
- **账号管理**：支持加密创建、编辑、归档、批量操作、邮箱精确查找、TOTP 自动刷新、恢复码管理，以及 OpenRouter 和 2FAuth 文件的浏览器端导入。
- **Sub2API 集成**：支持最小权限连接、自动或手动关联、配额与健康状态同步、告警确认，以及远端优先的关联账号删除。
- **统一运行时**：Next.js Web 与 `pg-boss` Worker 由同一个 supervisor 管理，并提供存活、就绪和 Worker 诊断端点。

## 技术基线

- Node.js 22.22.2
- pnpm 11.13.1
- Next.js 16.3.3 / React 19.2.4
- PostgreSQL 14 及以上

依赖版本均固定在 [package.json](./package.json)，安装时必须使用锁文件。

## 本地开发

安装依赖：

```bash
corepack pnpm install --frozen-lockfile
```

可使用仓库提供的 Compose 文件启动本地 PostgreSQL：

```bash
docker compose -f deploy/compose.dev.yml up -d
```

初始化页面使用以下本地数据库参数：

| 字段 | 值 |
| --- | --- |
| 主机 | `127.0.0.1` |
| 端口 | `55432` |
| 数据库 | `account_vault` |
| 用户名 | `account_vault` |
| 密码 | `local-development-only` |
| SSL 模式 | `disable` |

该固定密码仅用于绑定回环地址的本地容器，不得用于共享或生产数据库。

本地初始化前，在 `.runtime` 中创建以下两个文件：

- `account-vault-setup-token`：一次性初始化令牌文本。
- `account-vault-config-key`：恰好 32 字节的随机值，或该值的 43 字符 base64url 编码。

`.runtime` 已被 Git 忽略。启动开发服务器：

```bash
corepack pnpm dev
```

打开 `http://localhost:3000/setup` 完成初始化。

## 质量检查

日常改动至少运行：

```bash
corepack pnpm check
```

首次运行 Playwright 测试前安装 Chromium：

```bash
corepack pnpm exec playwright install chromium
```

提交或发布前运行完整门禁：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

完整通行密钥 E2E 与 Worker 运行时冒烟测试需要隔离的 PostgreSQL 和运行时密钥文件；通行密钥场景还需要 Chromium 虚拟认证器。GitHub Actions 提供完整环境，贡献规则见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 部署与状态

- 1Panel 部署与运行时校验：[deploy/1panel/README.md](./deploy/1panel/README.md)
- 当前实现范围与待办：[docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md)
- 安全问题报告：[SECURITY.md](./SECURITY.md)

动态页面和 API 响应均使用 `no-store`。CSP 中的 `wasm-unsafe-eval` 仅用于 Argon2id 和 libsodium 的 WebAssembly 编译，JavaScript `unsafe-eval` 仍然禁用。
