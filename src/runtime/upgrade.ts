import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { readRuntimeConfig } from "./config-store";
import { migrationsDirectory, releaseRoot } from "./paths";
import { runMigrations } from "@/server/database/migrate";
import { verifyDatabaseReadiness } from "@/server/database/readiness";

async function releaseMetadata() {
  const manifestPath = path.join(releaseRoot(), "release-manifest.json");
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    releaseId?: string;
    schemaVersion?: number;
  };
  await access(migrationsDirectory());
  return {
    releaseId: manifest.releaseId ?? "unknown",
    schemaVersion: manifest.schemaVersion ?? 1,
  };
}

async function main() {
  const command = process.argv[2];
  if (command !== "--check" && command !== "--apply") {
    throw new Error("Expected --check or --apply");
  }
  const release = await releaseMetadata();
  if (command === "--check") {
    process.stdout.write(
      `${JSON.stringify({ upgradeCheck: "ok", ...release })}\n`,
    );
    return;
  }

  if (process.env.ACCOUNT_VAULT_BACKUP_CONFIRMED !== "yes") {
    throw new Error(
      "Set ACCOUNT_VAULT_BACKUP_CONFIRMED=yes only after database and runtime config backups are verified",
    );
  }
  const config = await readRuntimeConfig();
  if (config.setupState !== "ready") {
    throw new Error("Upgrade migrations require an initialized READY runtime");
  }
  await runMigrations(config.database);
  await verifyDatabaseReadiness(config.database);
  process.stdout.write(
    `${JSON.stringify({ upgradeApply: "ok", ...release })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      upgradeCheck: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`,
  );
  process.exit(1);
});
