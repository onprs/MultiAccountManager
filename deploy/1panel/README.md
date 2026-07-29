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

## Domain migration

Application origins are encrypted runtime configuration, not build-time constants. Never derive the WebAuthn origin or RP ID from request headers.

Back up PostgreSQL and `runtime.enc`, stop the Account Vault runtime, then prepare a domain migration with a one-off container:

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

The command persists a migration ID, validates the new identity, revokes sessions and old-origin Passkeys, and enters owner credential setup without replacing the existing Vault. If the command is interrupted after writing `runtime.enc`, rerun the exact same command before starting the runtime; the migration ID makes the database work idempotent and prevents a newly registered Passkey from being revoked by a retry. After the command succeeds, start the runtime, open `/setup`, authenticate with the mounted Setup Token, and register a new Passkey for the existing owner. READY is restored after registration. A failed final config write can be retried through `/setup` or by rerunning the same migration command.

## Sub2API connection provisioning

The normal connection flow is the Passkey-gated `/connections` UI. Deploy the Sub2API scoped-delete endpoint first, then create a dedicated integration token with `allow_delete: true`; its canonical scope is `account_observer:read account_observer:delete`. Connection validation reads the granted scope from Sub2API and rejects old read-only tokens. To create a server-managed connection or replace the token on the existing exact name/Base URL match, place the new token in a root-owned `0600` file under the read-only secret mount, then run:

```bash
docker exec \
  -e SUB2API_OBSERVER_TOKEN_FILE=/run/secrets/sub2api-observer-token \
  -e SUB2API_BASE_URL=https://sub2api.example.com \
  -e SUB2API_CONNECTION_NAME=sub2api_tokyo \
  account-vault \
  node /app/current/dist/runtime/provision-sub2api-connection.mjs
```

The command validates the Observer instance and delete scope, encrypts the integration token with the service key ring, then creates the connection or atomically replaces its stored token before queuing a sync. It rejects ambiguous name/Base URL matches and remote instance changes. Remove the plaintext token file immediately after successful provisioning.

## Verification

After preparing and selecting a release, start the runtime and run inside it:

```bash
bash /app/current/deploy/1panel/verify-runtime.sh
```

Before setup, monitor `/api/health/live`; `/api/health/ready` intentionally returns 503 until owner creation is complete. Setup creates the configured application schema and a separate pg-boss job schema. After READY, confirm the `/connections` diagnostic shows a fresh `sync-worker` heartbeat; Sub2API connection failures do not make Web readiness fail.
