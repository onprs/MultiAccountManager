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
- CI-only isolated PostgreSQL 16 + Playwright virtual authenticator coverage for setup, all migrations, owner registration/login, Vault/Recovery Kit, encrypted account creation, TOTP, READY closure, and final-Passkey protection.

## Next slice

- Configure a Git remote and obtain a real GitHub Actions result for the PostgreSQL 16 + virtual-authenticator flow.
- Run PostgreSQL-backed account/recovery-code APIs and the expanded virtual-authenticator E2E in GitHub Actions after a remote is configured.
- Add generated QR fixtures for automated ZXing image coverage beyond manual browser verification.
- Add optional encrypted recovery-code batch labels; the database and API field already exist.
- Validate `0005_sub2api_sync.sql`, pg-boss installation, retry behavior, and Observer pagination against PostgreSQL 16 in CI.
- Select an external notification channel before implementing optional email/webhook delivery; in-app alerts are complete.
- Exercise production WebAuthn with the final HTTPS origin and RP ID.

## Deployment blockers

- `onprs` now passes the 1Panel version gate at v2.2.3.
- The final HTTPS hostname and WebAuthn RP ID are not yet fixed.
- A Node 22.22.2 runtime has not been created or validated on 1Panel.
- No local PostgreSQL CLI/server or Docker daemon is currently available for the disposable migration/adapter/account API test.
- Multi-user scope, account scale, notification channels, and PostgreSQL connection budget still need owner confirmation.
