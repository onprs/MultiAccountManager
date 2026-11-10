# Account Vault

> English: [README.en.md](./README.en.md)

Account Vault 是面向单一管理员的 AI 账号加密管理工具，提供账号凭据、TOTP、平台恢复码及 Sub2API 连接状态的集中管理与保护。

## 核心特性

- **端到端加密**：主密码与明文凭据仅存在于浏览器端，服务端仅持久化版本化密文信封与盲索引。
- **通行密钥认证**：基于 WebAuthn 的免密登录与操作提权，支持多凭据管理与防误删保护。
- **账号与 TOTP 管理**：提供多平台账号的加密管理、邮箱精确查找、一次性口令自动刷新及平台恢复码托管。
- **批量导入**：支持 OpenRouter 与 2FAuth 导出格式的浏览器端解析与加密导入。
- **Sub2API 集成**：支持配额快照与健康状态同步、告警协同及跨平台关联账号清理。
- **双安全域隔离**：用户保险库数据与第三方服务集成凭据采用独立的加密链路管理。
- **独立运行时**：Web 服务与后台作业由统一进程管理器托管，开箱即用。

## 技术要求

- Node.js 24.22.1
- pnpm 11.13.1
- Next.js 16.3.3 / React 19.2.4
- PostgreSQL 14 及以上版本

依赖版本见 [package.json](./package.json)。

## 快速开始

### 1. 安装依赖

```bash
corepack pnpm install --frozen-lockfile
```

### 2. 启动本地数据库

使用仓库提供的 Compose 文件启动本地 PostgreSQL 实例：

```bash
docker compose -f deploy/compose.dev.yml up -d
```

本地数据库默认连接参数：

| 字段     | 值                       |
| -------- | ------------------------ |
| 主机     | `127.0.0.1`              |
| 端口     | `55432`                  |
| 数据库   | `account_vault`          |
| 用户名   | `account_vault`          |
| 密码     | `local-development-only` |
| SSL 模式 | `disable`                |

### 3. 配置本地密钥文件

在 `.runtime` 目录下创建本地启动所需的密钥文件：

- `account-vault-setup-token`：自定义一次性初始化令牌文本。
- `account-vault-config-key`：32 字节随机值的 base64url 字符串。

生成命令示例：

```bash
mkdir -p .runtime
echo "local-setup-token" > .runtime/account-vault-setup-token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > .runtime/account-vault-config-key
```

### 4. 启动服务与初始化

启动本地开发服务：

```bash
corepack pnpm dev
```

在浏览器访问 `http://localhost:3000/setup`，根据引导完成数据库连接配置与首个通行密钥注册。

## 常用脚本

```bash
# 代码风格与类型检查
corepack pnpm check

# 完整单元测试与构建
corepack pnpm test
corepack pnpm build
```

## 相关文档

- 贡献指南与规范：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 生产环境部署（1Panel）：[deploy/1panel/README.md](./deploy/1panel/README.md)
- 实现状态与功能范围：[docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md)
- 安全策略与漏洞报告：[SECURITY.md](./SECURITY.md)
