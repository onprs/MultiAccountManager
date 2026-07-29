import { describe, expect, it } from "vitest";
import { expectedMigrationFiles } from "@/server/database/migrate";

describe("database migrations", () => {
  it("includes the Sub2API sync schema and service secret boundary", async () => {
    const migrations = await expectedMigrationFiles();
    const migration = migrations.find((entry) => entry.name === "0005_sub2api_sync.sql");
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("token_ciphertext jsonb not null");
    expect(migration?.sql).toContain("worker_heartbeats");
    expect(migration?.sql).toContain("account_alerts_active_dedupe_idx");
    expect(migration?.sql).toContain("'{\"version\":6}'::jsonb");
    expect(migration?.sql).not.toContain("plaintext_token");
    expect(migration?.sql).not.toContain("access_token");
    expect(migration?.sql).not.toContain("refresh_token");
  });

  it("adds ClinePass to the managed account platform constraint", async () => {
    const migrations = await expectedMigrationFiles();
    const migration = migrations.find(
      (entry) => entry.name === "0006_clinepass_account_platform.sql",
    );

    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("'clinepass'");
    expect(migration?.sql).toContain("'{\"version\":7}'::jsonb");
  });
});
