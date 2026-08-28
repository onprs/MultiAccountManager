# Account Vault

> 中文文档：[README.md](./README.md)

Account Vault is a single-owner, encrypted workspace for AI account operations. It manages account credentials, TOTP, platform recovery codes, and Sub2API connection health while keeping browser vault data and service integration credentials in separate security domains.

## Security boundaries

- The master password is entered only on the current page, passed directly to an isolated Crypto Worker, and never persisted. The Vault Root Key exists only inside that Worker, where record cryptography and TOTP generation run.
- Account plaintext, recovery keys, recovery codes, and generated one-time passwords leave the Worker only when the current page explicitly needs them for display, editing, or copying. They are never sent to the server or written to Web Storage or IndexedDB; a recovery key is written to a selected file only when the user explicitly downloads a Recovery Kit. Locking unmounts the workspace and terminates the Worker.
- For vault records, the server receives only versioned encrypted envelopes, blind indexes, and required non-sensitive metadata.
- Sub2API integration tokens belong to a separate security domain. The server handles a token briefly during a Passkey-verified connection flow or restricted-file provisioning, then encrypts it with an independent service key that never accesses the Vault Root Key.
- Production database credentials, authentication secrets, and service keys are stored in encrypted `runtime.enc`, never in source code, logs, or `NEXT_PUBLIC_*` variables.
- Production setup tokens and Config Master Keys are supplied only through restricted file mounts. Fixed values in this repository are loopback-only local development or isolated CI fixtures and must never be reused in production.

## Capabilities

- **Secure setup**: starts without a database, validates PostgreSQL through `/setup`, applies checksum-verified migrations, and creates the first administrator.
- **Passwordless authentication**: supports Passkey registration, sign-in, step-up verification, backup credentials, and last-credential deletion protection.
- **Browser-side vault**: uses Argon2id and XChaCha20-Poly1305 with password or recovery-key unlock, Recovery Kit confirmation, and key rotation.
- **Account management**: supports encrypted create/edit/archive/bulk workflows, exact email lookup, automatically refreshed TOTP, recovery codes, and browser-side OpenRouter and 2FAuth imports.
- **Sub2API integration**: provides least-privilege connections, automatic or manual linking, quota and health synchronization, alert acknowledgement, and remote-first linked-account deletion.
- **Unified runtime**: runs the Next.js Web process and `pg-boss` Worker under one supervisor with liveness, readiness, and Worker diagnostics.

## Toolchain

- Node.js 22.22.2
- pnpm 11.13.1
- Next.js 16.3.3 / React 19.2.4
- PostgreSQL 14 or newer

All dependency versions are pinned in [package.json](./package.json), and installations must use the lockfile.

## Local development

Install dependencies:

```bash
corepack pnpm install --frozen-lockfile
```

Start the optional local PostgreSQL service:

```bash
docker compose -f deploy/compose.dev.yml up -d
```

Use these database settings on the setup page:

| Field | Value |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `55432` |
| Database | `account_vault` |
| Username | `account_vault` |
| Password | `local-development-only` |
| SSL mode | `disable` |

This fixed password is only for the loopback-bound local container. Never use it for a shared or production database.

Before local setup, create these files under `.runtime`:

- `account-vault-setup-token`: a one-time setup token.
- `account-vault-config-key`: exactly 32 random bytes, or a 43-character base64url encoding of those bytes.

`.runtime` is ignored by Git. Start the development server:

```bash
corepack pnpm dev
```

Open `http://localhost:3000/setup` to initialize the application.

## Verification

Run the routine checks:

```bash
corepack pnpm check
```

Install Chromium before running Playwright for the first time:

```bash
corepack pnpm exec playwright install chromium
```

Before a commit or release, run the full gate:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

The complete Passkey E2E and Worker runtime smoke test require an isolated PostgreSQL database and runtime secret files; the Passkey scenario also needs a Chromium virtual authenticator. GitHub Actions provides the complete environment. See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository rules.

## Deployment and status

- 1Panel deployment and runtime verification: [deploy/1panel/README.md](./deploy/1panel/README.md)
- Current scope and follow-up work: [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md)
- Security reporting: [SECURITY.md](./SECURITY.md)

Dynamic pages and API responses use `no-store`. The CSP permits `wasm-unsafe-eval` only for Argon2id and libsodium WebAssembly compilation; JavaScript `unsafe-eval` remains disabled.
