import { PgBoss } from "pg-boss";
import type { RuntimeConfig } from "@/runtime/types";
import { databaseSslOptions, closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";
import {
  cleanupIntegrationHistory,
  ConnectionSyncError,
  refreshStaleSyncHealth,
  rotateServiceCiphertexts,
  syncSub2apiConnection,
  type SyncTrigger,
} from "@/server/integrations/sync";
import { readRuntimeConfig } from "@/runtime/config-store";

export const jobNames = {
  schedule: "schedule-sub2api-syncs",
  sync: "sync-sub2api-connection",
  evaluate: "evaluate-account-alerts",
  cleanup: "cleanup-sync-runs",
  rotate: "rotate-service-ciphertexts",
} as const;

type SyncJobData = { connectionId: string; trigger: SyncTrigger };
type WorkerLog = (level: "info" | "error", event: string, fields?: Record<string, unknown>) => void;

export async function startJobRuntime(config: RuntimeConfig, log: WorkerLog) {
  const boss = createBoss(config);
  boss.on("error", (error) => log("error", "pg_boss_error", { message: safeJobError(error) }));
  boss.on("warning", (warning) => log("error", "pg_boss_warning", { message: safeJobError(warning) }));
  await boss.start();
  await ensureQueues(boss);

  await boss.work<SyncJobData>(
    jobNames.sync,
    { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 1, heartbeatRefreshSeconds: 20 },
    async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      try {
        const result = await syncSub2apiConnection({
          connectionId: job.data.connectionId,
          trigger: job.data.trigger,
          jobId: job.id,
        });
        log("info", "connection_sync_complete", {
          jobId: job.id,
          connectionId: job.data.connectionId,
          status: result.status,
          pages: result.pages,
          accountsSeen: result.accountsSeen,
          invalidItems: result.invalidItems,
        });
        return result;
      } catch (error) {
        const syncError = error instanceof ConnectionSyncError ? error : null;
        log("error", "connection_sync_failed", {
          jobId: job.id,
          connectionId: job.data.connectionId,
          code: syncError?.code ?? "SYNC_FAILED",
          retryable: syncError?.retryable ?? true,
        });
        if (syncError && !syncError.retryable) return { status: "terminal", code: syncError.code };
        throw error;
      }
    },
  );
  await boss.work(jobNames.schedule, async () => {
    await scheduleDueConnections(boss);
  });
  await boss.work(jobNames.evaluate, async () => {
    await refreshStaleSyncHealth();
  });
  await boss.work(jobNames.cleanup, async () => {
    await cleanupIntegrationHistory();
  });
  await boss.work(jobNames.rotate, async () => {
    const migrated = await rotateServiceCiphertexts();
    log("info", "service_ciphertexts_rotated", { migrated });
  });

  await Promise.all([
    boss.schedule(jobNames.schedule, "* * * * *", null, { tz: "UTC", key: "scheduler" }),
    boss.schedule(jobNames.evaluate, "* * * * *", null, { tz: "UTC", key: "evaluator" }),
    boss.schedule(jobNames.cleanup, "17 3 * * *", null, { tz: "UTC", key: "retention" }),
    boss.schedule(jobNames.rotate, "11 * * * *", null, { tz: "UTC", key: "key-ring" }),
  ]);

  const startedAt = new Date();
  await writeHeartbeat(config, startedAt, "running", { queues: Object.values(jobNames) });
  const heartbeat = setInterval(() => {
    void writeHeartbeat(config, startedAt, "running", { queues: Object.values(jobNames) }).catch((error) => {
      log("error", "heartbeat_failed", { message: safeJobError(error) });
    });
  }, 30_000);
  heartbeat.unref();
  log("info", "pg_boss_started", { schema: config.database.jobSchema });

  return {
    async stop() {
      clearInterval(heartbeat);
      await writeHeartbeat(config, startedAt, "stopping", {}).catch(() => undefined);
      await boss.stop({ graceful: true, timeout: 30_000 });
      await writeHeartbeat(config, startedAt, "stopped", {}).catch(() => undefined);
    },
  };
}

export async function enqueueManualConnectionSync(connectionId: string): Promise<string | null> {
  const config = await readRuntimeConfig();
  const boss = createBoss(config);
  try {
    await boss.start();
    await ensureQueues(boss);
    return await boss.send(
      jobNames.sync,
      { connectionId, trigger: "manual" satisfies SyncTrigger },
      {
        singletonKey: connectionId,
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 300,
        expireInSeconds: 300,
      },
    );
  } finally {
    await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
  }
}

function createBoss(config: RuntimeConfig): PgBoss {
  return new PgBoss({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.username,
    password: config.database.password,
    ssl: databaseSslOptions(config.database),
    schema: config.database.jobSchema,
    max: config.database.workerPoolSize,
    application_name: "account-vault-worker",
    connectionTimeoutMillis: config.database.connectTimeoutSeconds * 1_000,
    migrate: true,
    createSchema: false,
    schedule: true,
    supervise: true,
  });
}

async function ensureQueues(boss: PgBoss): Promise<void> {
  const common = {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
  };
  await boss.createQueue(jobNames.sync, {
    ...common,
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 300,
    heartbeatSeconds: 60,
  });
  for (const name of [jobNames.schedule, jobNames.evaluate, jobNames.cleanup, jobNames.rotate]) {
    await boss.createQueue(name, {
      ...common,
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  }
}

async function scheduleDueConnections(boss: PgBoss): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const due = await sql<Array<{ id: string }>>`
      select id from sub2api_connections
      where enabled = true
        and (last_attempt_at is null or last_attempt_at <= now() - (sync_interval_seconds * interval '1 second'))
      order by coalesce(last_attempt_at, to_timestamp(0)), id
      limit 100
    `;
    for (const connection of due) {
      await boss.send(
        jobNames.sync,
        { connectionId: connection.id, trigger: "scheduled" satisfies SyncTrigger },
        {
          singletonKey: connection.id,
          startAfter: Math.floor(Math.random() * 15),
          retryLimit: 5,
          retryDelay: 5,
          retryBackoff: true,
          retryDelayMax: 300,
          expireInSeconds: 300,
        },
      );
    }
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

async function writeHeartbeat(
  config: RuntimeConfig,
  startedAt: Date,
  status: string,
  details: Record<string, unknown>,
): Promise<void> {
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql`
      insert into worker_heartbeats (
        component, release_id, process_id, status, details, heartbeat_at, started_at
      ) values (
        'sync-worker', ${process.env.ACCOUNT_VAULT_RELEASE_ID ?? "development"},
        ${process.pid}, ${status}, ${sql.json(details as never)}, now(), ${startedAt}
      )
      on conflict (component) do update
      set release_id = excluded.release_id, process_id = excluded.process_id,
          status = excluded.status, details = excluded.details,
          heartbeat_at = excluded.heartbeat_at, started_at = excluded.started_at
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

function safeJobError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/s2obs_[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 300);
  }
  return "job runtime error";
}
