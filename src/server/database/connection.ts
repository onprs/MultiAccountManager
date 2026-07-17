import postgres, { type Sql } from "postgres";
import type { DatabaseConfig } from "@/runtime/types";

function sslOptions(config: DatabaseConfig): false | "prefer" | "require" | Record<string, unknown> {
  switch (config.sslMode) {
    case "disable":
      return false;
    case "prefer":
      return "prefer";
    case "require":
      return "require";
    case "verify-full":
      return {
        rejectUnauthorized: true,
        ...(config.caCertificate ? { ca: config.caCertificate } : {}),
      };
  }
}

export function createDatabaseClient(
  config: DatabaseConfig,
  options: { max?: number } = {},
): Sql {
  return postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: sslOptions(config),
    connect_timeout: config.connectTimeoutSeconds,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    max: options.max ?? config.webPoolSize,
    prepare: false,
    connection: {
      application_name: "account-vault",
      search_path: `${config.schema},public`,
    },
    onnotice: () => undefined,
  });
}

export async function closeDatabaseClient(sql: Sql): Promise<void> {
  await sql.end({ timeout: 2 });
}
