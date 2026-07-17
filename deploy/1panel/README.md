# 1Panel deployment gate

Account Vault uses one Node.js runtime and one runtime-backed website. Do not create separate Web and Worker containers in the 1Panel orchestration page.

## Required baseline

- 1Panel v2.2.3 or newer.
- Node.js 22.22.2.
- The Node runtime option to disable automatic `node_modules` installation.
- A final HTTPS hostname before Passkey registration.
- Existing PostgreSQL with a dedicated database or schemas.

The observed `onprs` baseline now passes this gate at 1Panel v2.2.3. Deployment remains blocked until the Node 22.22.2 runtime and final HTTPS WebAuthn identity are available.

## Runtime fields

| Field | Value |
| --- | --- |
| Name | `account-vault` |
| Source directory | `/opt/account-vault/app` |
| Install node_modules | Off |
| Start command | `exec node /app/current/dist/runtime/supervisor.mjs` |
| Container port | `3000/tcp` |
| Host proxy port | Loopback-only, for example `33000` |
| Config mount | `/opt/account-vault/config:/app/config:rw` |
| Secret mount | `/opt/account-vault/secrets:/run/secrets:ro` |

Environment:

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

Do not place a database URL, database password, Better Auth secret, Sub2API token, or vault material in 1Panel environment variables.

## Secret files

Generate a one-time setup token and a separate 32-byte Config Master Key outside application logs. Store them as:

```text
/opt/account-vault/secrets/account-vault-setup-token
/opt/account-vault/secrets/account-vault-config-key
```

Both files must be `root:10001 0440`. The Config Master Key is long-lived and must be backed up separately from `runtime.enc`.

## Verification

After preparing and selecting a release, start the runtime and run inside it:

```bash
bash /app/current/deploy/1panel/verify-runtime.sh
```

Before setup, monitor `/api/health/live`; `/api/health/ready` intentionally returns 503 until owner creation is complete. Setup creates the configured application schema and a separate pg-boss job schema. After READY, confirm the `/connections` diagnostic shows a fresh `sync-worker` heartbeat; Sub2API connection failures do not make Web readiness fail.
