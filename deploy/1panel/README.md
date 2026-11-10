# 1Panel 部署指南

Account Vault 采用单容器模型部署，容器内由 supervisor 统一管理 Next.js Web 进程与 `pg-boss` Worker 任务进程。

## 环境要求

- 1Panel 2.2.3 或更高版本
- Node.js 24.22.1 运行镜像
- 外部 PostgreSQL 14+ 数据库（具备建表权限的独立 Database 或 Schema）
- 确定的公开 HTTPS 访问域名（WebAuthn 通行密钥依赖固定域名及 Origin）

## 容器与运行时配置

在 1Panel 创建 Node.js 运行环境：

| 配置项                | 推荐值                                               |
| --------------------- | ---------------------------------------------------- |
| 应用名称              | `account-vault`                                      |
| 运行目录              | `/opt/account-vault/app`                             |
| 自动安装 node_modules | 关闭                                                 |
| 启动命令              | `exec node /app/current/dist/runtime/supervisor.mjs` |
| 容器端口              | `3000/tcp`                                           |
| 宿主机端口映射        | 绑定回环地址，例如 `127.0.0.1:33000:3000`            |
| 存储挂载（配置）      | `/opt/account-vault/config:/app/config:rw`           |
| 存储挂载（凭据）      | `/opt/account-vault/secrets:/run/secrets:ro`         |

容器环境变量：

```text
NODE_ENV=production
HOSTNAME=0.0.0.0
PORT=3000
RUNTIME_CONFIG_DIR=/app/config
SETUP_TOKEN_FILE=/run/secrets/account-vault-setup-token
CONFIG_MASTER_KEY_FILE=/run/secrets/account-vault-config-key
LOG_LEVEL=info
SHUTDOWN_GRACE_SECONDS=30
```

> 数据库连接信息与认证密钥由初始化流程写入加密配置文件 `runtime.enc`，无需在容器环境变量中配置数据库密码。

## 密钥文件准备

在宿主机上创建凭据目录并生成一次性初始化令牌和 32 字节配置主密钥：

```bash
sudo mkdir -p /opt/account-vault/secrets
sudo mkdir -p /opt/account-vault/config

# 生成一次性初始化令牌
openssl rand -hex 24 | sudo tee /opt/account-vault/secrets/account-vault-setup-token > /dev/null

# 生成 32 字节配置主密钥（base64url 格式）
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | sudo tee /opt/account-vault/secrets/account-vault-config-key > /dev/null

# 配置文件权限（所有者为 root，应用容器 UID 10001 具读取权限）
sudo chown -R root:10001 /opt/account-vault/secrets
sudo chmod 0440 /opt/account-vault/secrets/*
```

配置主密钥用于加解密 `runtime.enc`，建议离线多副本保存。

## 发布流程

1. **构建产物**：在构建环境运行质量检查并打包发布文件。
2. **生成版本目录**：使用发布脚本准备包含提交标识的发布目录（例如 `/opt/account-vault/app/releases/<version>`）。
3. **软链接切换**：将 `/opt/account-vault/app/current` 指向新版本目录。
4. **启动与检查**：启动 supervisor，监控容器启动日志与健康端点。

构建与校验命令：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

## 首次初始化（Setup）

启动后，在未完成管理员注册前，就绪探针 `/api/health/ready` 返回 `503`，存活探针 `/api/health/live` 返回 `200`。

通过 HTTPS 域名访问 `/setup`，根据向导完成配置：

1. 输入挂载的初始化令牌（`account-vault-setup-token` 内容）；
2. 填写 PostgreSQL 连接参数并执行迁移校验；
3. 确认公开访问 URL 与 WebAuthn RP ID；
4. 注册首位管理员通行密钥；
5. 设置主密码初始化浏览器端保险库；
6. 下载并确认离线恢复套件。

完成初始化后，`/api/health/ready` 状态转为 `200`，Setup 入口自动锁定。

## 运维操作

### 域名与 WebAuthn 身份迁移

域名变更需要重新配置 WebAuthn Origin 与 RP ID。操作前完成数据库及 `runtime.enc` 备份：

```bash
docker run --rm --user 10001:10001 --network 1panel-network \
  -e NODE_ENV=production \
  -e RUNTIME_CONFIG_DIR=/app/config \
  -e CONFIG_MASTER_KEY_FILE=/run/secrets/account-vault-config-key \
  -e ACCOUNT_VAULT_BACKUP_CONFIRMED=yes \
  -e ACCOUNT_VAULT_DOMAIN_MIGRATION_CONFIRMED=yes \
  -v /opt/account-vault/app:/app:ro \
  -v /opt/account-vault/config:/app/config:rw \
  -v /opt/account-vault/secrets:/run/secrets:ro \
  -w /app/current \
  1panel/node:24.22.1 \
  node dist/runtime/reconfigure-domain.mjs \
    --public-url https://new-domain.example.com \
    --rp-id new-domain.example.com
```

执行成功后启动容器，访问新域名的 `/setup` 重新为管理员注册新域名下的通行密钥。

### Sub2API 连接预配

Sub2API 连接通常由管理员登录后在 `/connections` 界面配置。

若通过命令行预配，可临时将令牌文件挂载至容器执行预配脚本：

```bash
# 宿主机创建临时令牌文件
sudo install -o root -g root -m 0600 /dev/null /opt/account-vault/secrets/sub2api-observer-token
read -r -s -p "输入 Sub2API Observer Token: " SUB2API_TOKEN && printf '\n'
printf '%s' "$SUB2API_TOKEN" | sudo tee /opt/account-vault/secrets/sub2api-observer-token >/dev/null
unset SUB2API_TOKEN

# 执行预配命令
docker exec --user 0:0 \
  -e SUB2API_OBSERVER_TOKEN_FILE=/run/secrets/sub2api-observer-token \
  -e SUB2API_BASE_URL=https://sub2api.example.com \
  -e SUB2API_CONNECTION_NAME=sub2api_default \
  account-vault \
  node /app/current/dist/runtime/provision-sub2api-connection.mjs

# 预配完成后清理临时文件
sudo rm -f /opt/account-vault/secrets/sub2api-observer-token
```

## 运行时状态校验

部署完成后，在容器内执行运行时基线校验：

```bash
bash /app/current/deploy/1panel/verify-runtime.sh
```

脚本将校验 Node.js 版本、发布清单哈希、supervisor 进程拓扑、运行 UID、敏感文件挂载权限及健康检查接口。
