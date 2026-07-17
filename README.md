# Account Vault

Account Vault is an internal Next.js application for encrypted AI account records and read-only Sub2API status observation. The browser-side vault and Sub2API service credentials are separate security domains.

The application starts without a database, validates an existing PostgreSQL instance through `/setup`, runs checksum migrations, and writes an authenticated encrypted `runtime.enc`. Setup creates the unique owner and a user-verified Passkey without a temporary password, then requires browser-side Vault initialization and Recovery Kit confirmation before READY. Security settings support named backup credentials, session-bound Passkey step-up, and transactional last-credential deletion protection.

Vault Root Key wrapping, account-record encryption, blind indexes, Argon2id, XChaCha20-Poly1305, and TOTP generation run in an isolated same-origin Crypto Worker. The server accepts only versioned encrypted envelopes for sensitive account fields. The account workspace supports encrypted create/edit/archive/delete, server-side pagination and filters, exact blind-index email lookup, local `otpauth://totp`/Base32/image/camera import, 2FAuth schema-1 JSON migration, on-demand masked OTP generation with server clock checks, and Passkey-gated recovery-code reveal/copy.

## Toolchain

- Node.js 22.22.2 production baseline
- pnpm 11.13.1
- Next.js 16.2.10 / React 19.2.4
- PostgreSQL 14 or newer

## Local verification

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
```

For local Setup Mode, create `.runtime/account-vault-setup-token` and `.runtime/account-vault-config-key`. The setup token is text; the config key is exactly 32 random bytes or a 43-character base64url encoding of 32 random bytes. `.runtime` is ignored by Git.

Start the app:

```bash
corepack pnpm dev
```

Open `http://localhost:3000/setup`. Dynamic setup and API responses are `no-store`; runtime secrets must never be placed in `NEXT_PUBLIC_*` variables. The CSP permits `wasm-unsafe-eval` only because Argon2id/libsodium compile WebAssembly; JavaScript `unsafe-eval` remains disabled.

The normal Playwright suite runs without PostgreSQL and skips the full Passkey scenario. CI supplies PostgreSQL 16 and runs migrations, virtual-authenticator owner bootstrap/login, Vault initialization, Recovery Kit confirmation, encrypted account creation, and TOTP checks.

Deployment requirements and the current 1Panel gate are in `deploy/1panel/README.md`. Implementation progress is tracked in `docs/IMPLEMENTATION_STATUS.md`.
