import type { DatabaseConfig } from "@/runtime/types";
import { closeDatabaseClient, createDatabaseClient } from "./connection";

export type DatabaseTestResult = {
  ok: true;
  serverVersion: string;
  database: string;
  username: string;
  serverTime: string;
  timezone: string;
  readOnly: boolean;
  schemaStatus: "missing" | "empty" | "managed";
  canInitialize: boolean;
  poolBudget: number;
};

export class DatabaseValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseValidationError";
    this.code = code;
  }
}

export async function testDatabaseConnection(
  config: DatabaseConfig,
): Promise<DatabaseTestResult> {
  if (config.webPoolSize + config.workerPoolSize > 80) {
    throw new DatabaseValidationError(
      "POOL_BUDGET_EXCEEDED",
      "The combined Web and Worker pool budget cannot exceed 80 connections",
    );
  }

  const sql = createDatabaseClient(config, { max: 1 });
  try {
    const [server] = await sql<
      Array<{
        server_version: string;
        server_version_num: string;
        database_name: string;
        username: string;
        server_time: Date;
        timezone: string;
        read_only: string;
        can_connect: boolean;
        can_create_schema: boolean;
      }>
    >`
      select
        current_setting('server_version') as server_version,
        current_setting('server_version_num') as server_version_num,
        current_database() as database_name,
        current_user as username,
        clock_timestamp() as server_time,
        current_setting('TimeZone') as timezone,
        current_setting('transaction_read_only') as read_only,
        has_database_privilege(current_user, current_database(), 'CONNECT') as can_connect,
        has_database_privilege(current_user, current_database(), 'CREATE') as can_create_schema
    `;

    if (!server || Number(server.server_version_num) < 140000) {
      throw new DatabaseValidationError(
        "POSTGRES_VERSION_UNSUPPORTED",
        "PostgreSQL 14 or newer is required",
      );
    }
    if (server.read_only === "on") {
      throw new DatabaseValidationError(
        "DATABASE_READ_ONLY",
        "The selected PostgreSQL connection is read-only",
      );
    }

    const [schema] = await sql<
      Array<{ exists: boolean; can_use: boolean; can_create: boolean }>
    >`
      select
        n.oid is not null as exists,
        coalesce(has_schema_privilege(current_user, n.oid, 'USAGE'), false) as can_use,
        coalesce(has_schema_privilege(current_user, n.oid, 'CREATE'), false) as can_create
      from (values (true)) as seed(present)
      left join pg_namespace n on n.nspname = ${config.schema}
    `;

    let schemaStatus: DatabaseTestResult["schemaStatus"] = "missing";
    if (schema?.exists) {
      const tables = await sql<Array<{ table_name: string }>>`
        select table_name
        from information_schema.tables
        where table_schema = ${config.schema} and table_type = 'BASE TABLE'
        order by table_name
      `;
      const names = tables.map((table) => table.table_name);
      const managed = names.includes("_account_vault_migrations");
      if (names.length > 0 && !managed) {
        throw new DatabaseValidationError(
          "SCHEMA_CONFLICT",
          "The target schema contains tables not managed by Account Vault",
        );
      }
      schemaStatus = managed ? "managed" : "empty";
    }

    const canInitialize = Boolean(
      server.can_connect &&
        (schema?.exists
          ? schema.can_use && schema.can_create
          : server.can_create_schema),
    );
    if (!canInitialize) {
      throw new DatabaseValidationError(
        "DATABASE_PERMISSION_DENIED",
        "The database user lacks the schema permissions required for migrations",
      );
    }

    return {
      ok: true,
      serverVersion: server.server_version,
      database: server.database_name,
      username: server.username,
      serverTime: server.server_time.toISOString(),
      timezone: server.timezone,
      readOnly: false,
      schemaStatus,
      canInitialize,
      poolBudget: config.webPoolSize + config.workerPoolSize,
    };
  } catch (error) {
    if (error instanceof DatabaseValidationError) throw error;
    const code = (error as { code?: string }).code;
    if (code === "28P01") {
      throw new DatabaseValidationError(
        "DATABASE_AUTHENTICATION_FAILED",
        "PostgreSQL rejected the supplied credentials",
      );
    }
    if (code === "3D000") {
      throw new DatabaseValidationError(
        "DATABASE_NOT_FOUND",
        "The selected PostgreSQL database does not exist",
      );
    }
    throw new DatabaseValidationError(
      "DATABASE_CONNECTION_FAILED",
      "The PostgreSQL connection or TLS validation failed",
    );
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}
