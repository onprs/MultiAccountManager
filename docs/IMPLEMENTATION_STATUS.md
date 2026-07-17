# Implementation status

Baseline: first vertical iteration from `Plan_20260716_224122.md`.

## Implemented

- Independent Next.js 16 App Router project with pinned pnpm and Node baselines; pnpm 11 is required because the pnpm 9 audit client targets the retired npm audit endpoint.
- Standalone build, Worker bundle, PID 1 supervisor, child UID/GID split, signal forwarding, and release hash verification.
- Database-free Setup Mode and live/ready health endpoints.
- Setup Token session with same-origin checks, constant-time comparison, expiry, single active session, and basic attempt limiting.
- Structured PostgreSQL connection validation for version, read-only state, schema conflicts, privileges, TLS mode, and pool budget.
- Transactional checksum migrations protected by a PostgreSQL advisory lock.
- XChaCha20-Poly1305 `runtime.enc` storage using a Config Master Key file, atomic replacement, and authenticated config schema.
- Setup UI through database migration and the unique owner bootstrap.
- Better Auth with reviewed Drizzle/PostgreSQL schema and Passkey-only route allowlists.
- Passkey-first owner registration using a short-lived signed setup context, repeated context validation, and mandatory WebAuthn user verification.
- Server-confirmed `creating_owner -> creating_vault -> ready` transition: owner Passkey completion revokes Setup access, while Recovery Kit confirmation is required before READY.
- Conditional Passkey login UI plus owner-only Passkey listing, naming, backup registration, and deletion.
- Session-bound five-minute Passkey step-up, transactional step-up consumption, and concurrent last-Passkey deletion protection.
- CI, release manifest generation, 1Panel helper scripts, and fallback OCI build.
- Isolated same-origin Crypto Worker bundle with serialized requests, idle/manual/sign-out lock, key zeroization, and no source maps.
- Frozen crypto envelope v1 using Argon2id, XChaCha20-Poly1305, owner/type/record-bound AAD, separated data/index/recovery KDF domains, and canonical base64url.
- Vault initialization, password/recovery unlock, password rewrap, Recovery Kit one-time display/confirmation, and Passkey-gated recovery rotation.
- Strict owner-scoped Vault APIs with revision locking; API schemas never accept a master password, KEK, Vault Root Key, or decrypted payload.
- CSP WebAssembly allowance without JavaScript `unsafe-eval`, plus desktop/mobile browser Worker tests for Argon2id, AEAD tamper/AAD rejection, and RFC 6238 vectors.
- Managed account and recovery-code schema migration plus owner-scoped account list/create/get/update/soft-delete APIs with revision locking and audit metadata.
- Encrypted account workspace with server pagination, URL-restorable non-sensitive filters, exact email blind-index search, current-page decryption, responsive rows, details, edit, archive, and delete.
- Browser-only `otpauth://totp`/Base32/image validation and preview, TOTP replace/remove, encrypted storage, RFC 6238 generation, masked reveal/copy, and server clock-skew warning.
- Client-only 2FAuth schema-1 JSON import with platform allowlisting, duplicate/malformed reporting, and no icon/base64 upload.
- Recovery-code batch normalization, exact blind-index deduplication, per-code encryption, metadata-only lists, Passkey-gated transactional reveal, copy, used/restored state, and deletion UI.
- Separate service encryption key ring with owner/connection-bound XChaCha token envelopes, Passkey-gated token creation/replacement and service-key rotation with previous-key migration.
- Sub2API connection validation for HTTPS, scoped authentication, observer schema, stable instance ID, redirect refusal, response size, item isolation, and remote clock skew.
- Remote account catalog, manual platform-safe links, account-detail integration status, stored quota windows, and connection diagnostics.
- Independent `pg-boss` Worker with unique per-connection jobs, cron scheduling, jitter, bounded pagination, transient backoff, graceful shutdown, PostgreSQL heartbeat, and manual enqueue.
- Normalized account/sync health, two-run missing detection, deduplicated state events, two-observation alert debounce, in-app acknowledge, automatic resolve, and retention cleanup.
- Observer secret-leak fixtures reject `credentials`/raw `extra`; service-token AAD and previous-key decryption have unit coverage.
- Isolated PostgreSQL 16 + Playwright virtual authenticator coverage for setup, all migrations, owner registration/login, Vault/Recovery Kit, encrypted account creation, TOTP, recovery codes, READY closure, and final-Passkey protection.
- PostgreSQL 16.14 acceptance of migrations `0000` through `0005`, encrypted database boundaries, pg-boss tables/queues/schedules, heartbeat refresh, minute jobs, and graceful Worker stop.
- Built Worker runtime smoke starts `dist/worker/index.mjs`, verifies the child-PID heartbeat, and requires a clean SIGTERM/stopped heartbeat on Linux CI.
- SHA256-verified Node 22.22.2 acceptance of the release guard, bundled Worker, and supervisor-managed standalone Web + Worker startup with live/ready health.

## Next slice

- Configure a Git remote and obtain a real GitHub Actions result for the PostgreSQL 16, virtual-authenticator, and built-Worker smoke flow.
- Add generated QR fixtures for automated ZXing image coverage beyond manual browser verification.
- Add optional encrypted recovery-code batch labels; the database and API field already exist.
- Validate Observer pagination/retry behavior against a live Sub2API instance using a disposable scoped token.
- Select an external notification channel before implementing optional email/webhook delivery; in-app alerts are complete.
- Exercise production WebAuthn with the final HTTPS origin and RP ID.

## Deployment blockers

- `onprs` now passes the 1Panel version gate at v2.2.3.
- The final HTTPS hostname and WebAuthn RP ID are not yet fixed.
- Node 22.22.2 passes portable Windows release/supervisor acceptance, but the production Linux runtime has not been created or validated on 1Panel.
- PostgreSQL 16.14 is available through Debian WSL for disposable acceptance. Docker Desktop remains unavailable because the custom kernel configured in `C:\Users\liang\.wslconfig` lacks `iso9660`, which Docker's WSL bootstrap requires.
- Multi-user scope, account scale, notification channels, and production PostgreSQL connection budget still need owner confirmation.
