# 1Panel 部署门禁

Account Vault 使用一个 Node.js 运行时和一个由运行时托管的网站。Web 与 Worker 必须由同一个 supervisor 管理，不要在 1Panel 编排中拆成两个独立容器。

## 基线要求

- 1Panel 2.2.3 或更高版本；
- Node.js 22.22.2；
- 关闭运行时自动安装 `node_modules`；
- 在注册通行密钥前确定最终 HTTPS 域名；
- 提供现有 PostgreSQL 实例及专用数据库或 Schema；
- 发布前通过仓库 CI 与依赖审计，并在发布版本启动后通过运行时校验。

## 运行时配置

| 字段 | 值 |
| --- | --- |
| 名称 | `account-vault` |
| 源码目录 | `/opt/account-vault/app` |
| 自动安装 node_modules | 关闭 |
| 启动命令 | `exec node /app/current/dist/runtime/supervisor.mjs` |
| 容器端口 | `3000/tcp` |
| 宿主机代理端口 | 仅监听回环地址，例如 `33000` |
| 配置挂载 | `/opt/account-vault/config:/app/config:rw` |
| 密钥挂载 | `/opt/account-vault/secrets:/run/secrets:ro` |

环境变量：

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

不要把数据库地址、数据库密码、Better Auth Secret、Sub2API 令牌或任何保险库材料写入 1Panel 环境变量。

## 密钥文件

在应用日志之外生成一次性初始化令牌和独立的 32 字节配置主密钥，分别保存为：

```text
/opt/account-vault/secrets/account-vault-setup-token
/opt/account-vault/secrets/account-vault-config-key
```

两个文件必须设置为 `root:10001 0440`。配置主密钥是长期密钥，必须与 `runtime.enc` 分开备份。

## 发布流程

1. 在干净工作树中安装锁定依赖并运行完整质量门禁。
2. 构建发布产物，确认 `release-manifest.json` 由当前源码生成。
3. 使用 `deploy/1panel/prepare-release.sh` 准备带提交标识的不可变发布目录。
4. 核对暂存和发布内容不包含 `.runtime*`、`.env*`、日志、数据库、真实账号数据或任何密钥。
5. 原子切换 `/app/current` 后启动 supervisor。
6. 在容器内执行运行时校验，并检查 Web 与 Worker 心跳。

构建前门禁：

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

## 首次初始化

启动后先监控 `/api/health/live`。在管理员与保险库恢复套件确认完成前，`/api/health/ready` 返回 `503` 属于预期行为。

通过最终 HTTPS 域名打开 `/setup`，依次完成：

1. 验证挂载的初始化令牌；
2. 测试 PostgreSQL 并创建应用与任务 Schema；
3. 固定公开地址、WebAuthn RP ID、Origin 和时区；
4. 注册首位管理员通行密钥；
5. 登录并初始化浏览器保险库；
6. 离线保存并确认恢复套件。

完成后确认 Setup 写入已关闭、`/api/health/ready` 返回 `200`，并检查 `/connections` 中后台同步心跳新鲜。

## 域名迁移

应用 Origin 保存在加密运行时配置中，不得从请求头动态推导 WebAuthn Origin 或 RP ID。

先备份 PostgreSQL 和 `runtime.enc`，停止 Account Vault，再使用一次性容器准备迁移：

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
  1panel/node:22.22.2 \
  node dist/runtime/reconfigure-domain.mjs \
    --public-url https://vault.example.com \
    --rp-id vault.example.com
```

命令会持久化迁移 ID、校验新身份、撤销会话和旧来源通行密钥，并进入管理员凭据重新注册状态，不会替换现有保险库。若写入 `runtime.enc` 后中断，必须在启动运行时前使用完全相同的参数重试；迁移 ID 会保证数据库操作幂等。

命令成功后启动运行时，打开 `/setup`，验证初始化令牌并为现有管理员注册新通行密钥。注册完成后恢复 READY。

## Sub2API 连接预配

常规流程是在 `/connections` 中通过通行密钥验证后创建连接。集成令牌必须具备规范权限：

```text
account_observer:read account_observer:delete
```

如需通过服务器预配或替换完全匹配的连接，在宿主机的密钥目录中临时创建仅 root 可读的令牌文件。不要在容器内尝试写入只读挂载，也不要把令牌放入命令参数或环境变量：

```bash
sudo install -o root -g root -m 0600 /dev/null /opt/account-vault/secrets/sub2api-observer-token
read -r -s -p "Sub2API Observer Token: " SUB2API_TOKEN && printf '\n'
printf '%s' "$SUB2API_TOKEN" | sudo tee /opt/account-vault/secrets/sub2api-observer-token >/dev/null
unset SUB2API_TOKEN
```

预配进程需要以 root 读取该一次性文件；Web 与 Worker 仍由 supervisor 分别降权到其专用 UID：

```bash
docker exec --user 0:0 \
  -e SUB2API_OBSERVER_TOKEN_FILE=/run/secrets/sub2api-observer-token \
  -e SUB2API_BASE_URL=https://sub2api.example.com \
  -e SUB2API_CONNECTION_NAME=sub2api_tokyo \
  account-vault \
  node /app/current/dist/runtime/provision-sub2api-connection.mjs
```

命令会验证远端实例与删除权限，使用服务密钥环加密令牌，并创建连接或原子替换同名、同地址连接的令牌。无论命令成功还是失败，都应立即在宿主机删除明文文件：

```bash
sudo rm -f /opt/account-vault/secrets/sub2api-observer-token
```

未经明确指示，不得操作 `sub2api_tokyo` 之外的线上实例。

## 运行时验证

启动发布版本后，在容器内执行：

```bash
bash /app/current/deploy/1panel/verify-runtime.sh
```

校验必须确认 Node 版本、发布清单、PID 1 supervisor、Web/Worker UID、只读密钥挂载、存活与就绪状态以及 Worker 心跳。Sub2API 单个连接失败不应使 Web 就绪探针失败。
