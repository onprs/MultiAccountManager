#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <release-directory> <release-id>\n' "$0" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
release_id="$2"
install_root="${ACCOUNT_VAULT_INSTALL_ROOT:-/opt/account-vault}"
target="$install_root/app/releases/$release_id"

[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'invalid release id\n' >&2; exit 2; }
[[ -f "$source_dir/release-manifest.json" ]] || { printf 'missing release manifest\n' >&2; exit 1; }
[[ ! -e "$target" ]] || { printf 'release already exists: %s\n' "$target" >&2; exit 1; }

install -d -o root -g root -m 0755 "$install_root/app/releases"
install -d -o 10001 -g 10001 -m 0750 "$install_root/config"
install -d -o root -g 10001 -m 0750 "$install_root/secrets"
cp -a "$source_dir" "$target"
chown -R root:root "$target"
find "$target" -type d -exec chmod 0755 {} +
find "$target" -type f -exec chmod 0644 {} +
chmod 0555 "$target/dist/runtime/supervisor.mjs" "$target/dist/worker/index.mjs" "$target/.next/standalone/server.js"

printf 'release_prepared=true target=%s\n' "$target"
printf 'next_step=ln -sfn %s %s/app/current.new && mv -Tf %s/app/current.new %s/app/current\n' "$target" "$install_root" "$install_root" "$install_root"
