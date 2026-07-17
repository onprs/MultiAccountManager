export function configDirectory(): string {
  return process.env.RUNTIME_CONFIG_DIR || ".runtime";
}

export function runtimeConfigPath(): string {
  return `${configDirectory()}/runtime.enc`;
}

export function configMasterKeyPath(): string {
  return (
    process.env.CONFIG_MASTER_KEY_FILE ||
    `${configDirectory()}/account-vault-config-key`
  );
}

export function setupTokenPath(): string {
  return (
    process.env.SETUP_TOKEN_FILE ||
    `${configDirectory()}/account-vault-setup-token`
  );
}

export function releaseRoot(): string {
  return process.env.ACCOUNT_VAULT_RELEASE_ROOT || ".";
}

export function migrationsDirectory(): string {
  return process.env.DB_MIGRATIONS_DIR || `${releaseRoot()}/db/migrations`;
}
