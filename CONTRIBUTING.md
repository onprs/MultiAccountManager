# 贡献指南

## 环境准备

- Node.js 24.22.1
- pnpm 11.13.1（通过 Corepack 启用）
- PostgreSQL 14 及以上（通行密钥端到端测试推荐 PostgreSQL 16）

安装依赖并保持锁文件同步：

```bash
corepack pnpm install --frozen-lockfile
```

运行浏览器端到端测试前安装依赖的浏览器：

```bash
corepack pnpm exec playwright install chromium
```

## 架构职责划分

项目代码按关注点清晰划分模块：

| 模块目录                         | 职责范围                                           |
| -------------------------------- | -------------------------------------------------- |
| `src/app/api`                    | HTTP 请求解析、输入校验与响应适配                  |
| `src/server`                     | 领域业务逻辑、认证鉴权及数据库持久化               |
| `src/crypto`                     | 浏览器端密码学算法、密钥派生及 Worker 生命周期管理 |
| `src/runtime`                    | 运行时配置加解密、配置重载与 supervisor 进程编排   |
| `src/worker` / `src/server/jobs` | 后台异步队列管理与定时同步任务                     |

## 安全与数据规范

- **客户端零知识模型**：主密码与保险库根密钥仅驻留于浏览器 Crypto Worker 内存。加解密计算与 TOTP 生成在 Worker 内完成，服务端仅存储版本化密文信封与盲索引。明文仅在用户主动查看或复制时呈现。
- **密钥域分离**：用户保险库内容与外部服务（如 Sub2API）集成凭据采用独立的加密密钥与操作链路。
- **凭据外部化**：生产环境凭据、会话密钥与服务令牌通过受限权限的文件挂载注入，避免进入源码、构建产物、日志及客户端变量。测试夹具仅用于本地 Docker 或 CI 隔离容器。
- **数据迁移演进**：已发布的数据库迁移保持不可变；新增迁移采用递增序号，并同步维护校验和机制。
- **界面语言规范**：UI 默认采用简体中文，标准协议名称（如 WebAuthn、TOTP）与专有名词保持原样。

## 质量验证

开发阶段常规验证：

```bash
corepack pnpm check
```

提交代码前执行完整验证门禁：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

涉及浏览器端密码学、认证流程或交互界面变更时，运行端到端测试：

```bash
corepack pnpm test:e2e
```

## 提交与安全披露

提交变更前检查工作区状态：

```bash
git status --short
git diff --check
git diff --cached --name-only
```

确认提交内容仅包含预期变更，排除临时日志、测试生成的凭据文件（`.runtime*`、`.env*`、`runtime.enc`）及构建产物。

关于安全漏洞的报告与披露流程，请参考 [SECURITY.md](./SECURITY.md)。
