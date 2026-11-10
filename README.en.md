# Account Vault

> 中文文档：[README.md](./README.md)

Account Vault is a single-owner, encrypted workspace for AI account operations. It centralizes account credentials, TOTP generation, recovery codes, and Sub2API integration health.

## Features

- **End-to-End Encryption**: Master passwords and decrypted credentials remain strictly within the browser; the server persists only versioned ciphertext envelopes and blind indexes.
- **Passkey Authentication**: WebAuthn-based passwordless login and step-up verification with multi-credential management and last-credential protection.
- **Account & TOTP Management**: Encrypted storage for multiple platform credentials, exact email search, auto-refreshing one-time passwords, and recovery code backups.
- **Batch Import**: Client-side parsing and encrypted import for OpenRouter and 2FAuth exported formats.
- **Sub2API Integration**: Quota snapshots, health state synchronization, alert acknowledgements, and synchronized remote account removal.
- **Dual Security Domains**: User vault contents and external service integration tokens are managed using isolated cryptographic keys.
- **Unified Runtime**: Web server and background job worker managed by a single process supervisor.

## Requirements

- Node.js 24.22.1
- pnpm 11.13.1
- Next.js 16.3.3 / React 19.2.4
- PostgreSQL 14 or newer

Pinned dependency versions are declared in [package.json](./package.json).

## Getting Started

### 1. Install dependencies

```bash
corepack pnpm install --frozen-lockfile
```

### 2. Start the local database

Start the local PostgreSQL service with the provided Compose configuration:

```bash
docker compose -f deploy/compose.dev.yml up -d
```

Default local database connection values:

| Field    | Value                    |
| -------- | ------------------------ |
| Host     | `127.0.0.1`              |
| Port     | `55432`                  |
| Database | `account_vault`          |
| Username | `account_vault`          |
| Password | `local-development-only` |
| SSL Mode | `disable`                |

### 3. Prepare local secret files

Create the local setup secret files under `.runtime`:

- `account-vault-setup-token`: A single-use setup token.
- `account-vault-config-key`: A 32-byte random base64url string.

Example generation command:

```bash
mkdir -p .runtime
echo "local-setup-token" > .runtime/account-vault-setup-token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > .runtime/account-vault-config-key
```

### 4. Start the development server

Start the application:

```bash
corepack pnpm dev
```

Navigate to `http://localhost:3000/setup` in your browser to complete database configuration and register the initial administrator passkey.

## Common Scripts

```bash
# Linting and type checking
corepack pnpm check

# Unit tests and production build
corepack pnpm test
corepack pnpm build
```

## Documentation

- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- 1Panel deployment: [deploy/1panel/README.md](./deploy/1panel/README.md)
- Implementation status: [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md)
- Security policy: [SECURITY.md](./SECURITY.md)
