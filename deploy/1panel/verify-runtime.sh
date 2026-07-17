#!/usr/bin/env bash
set -euo pipefail

release_root="${ACCOUNT_VAULT_RELEASE_ROOT:-/app/current}"
config_dir="${RUNTIME_CONFIG_DIR:-/app/config}"

fail() {
  printf 'runtime_check_ok=false check=%s\n' "$1" >&2
  exit 1
}

node_version="$(node --version)"
[[ "$node_version" == "v22.22.2" ]] || fail "node_version"
[[ -r "$release_root/release-manifest.json" ]] || fail "release_manifest"
[[ -r "$release_root/.next/standalone/server.js" ]] || fail "web_entry"
[[ -r "$release_root/dist/worker/index.mjs" ]] || fail "worker_entry"
[[ -r "$release_root/dist/runtime/supervisor.mjs" ]] || fail "supervisor_entry"
[[ -d "$config_dir" && -w "$config_dir" ]] || fail "config_mount"
[[ -r "${CONFIG_MASTER_KEY_FILE:-/run/secrets/account-vault-config-key}" ]] || fail "config_key"
[[ -r "${SETUP_TOKEN_FILE:-/run/secrets/account-vault-setup-token}" ]] || fail "setup_token"

pid_one="$(tr '\0' ' ' </proc/1/cmdline)"
[[ "$pid_one" == *"supervisor.mjs"* ]] || fail "pid_one"

web_uid="$(ps -eo ppid=,uid= | awk '$1 == 1 && $2 == 10001 {print $2; exit}')"
worker_uid="$(ps -eo ppid=,uid= | awk '$1 == 1 && $2 == 10002 {print $2; exit}')"
[[ "$web_uid" == "10001" ]] || fail "web_uid"
[[ "$worker_uid" == "10002" ]] || fail "worker_uid"

printf 'runtime_check_ok=true node=%s web_uid=%s worker_uid=%s\n' "$node_version" "$web_uid" "$worker_uid"
