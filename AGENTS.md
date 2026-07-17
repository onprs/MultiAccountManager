# Account Vault agent guide

- Keep the user vault and service integration credentials as separate security domains.
- Vault plaintext, master passwords, root keys, TOTP secrets, recovery codes, and OTP values must remain browser-only.
- Database credentials and service keys belong only in encrypted runtime configuration; never put them in Git, logs, `NEXT_PUBLIC_*`, or production environment variables.
- Setup routes must work without an initialized database or auth singleton.
- Route handlers adapt HTTP only; keep database and domain behavior under `src/server`.
- Pin production dependency versions and keep `pnpm-lock.yaml` synchronized.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before release.
- Do not deploy to 1Panel unless `deploy/1panel/verify-runtime.sh` can pass the documented baseline.
