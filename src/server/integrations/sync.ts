import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { ObserverAccount, ServiceCiphertext } from "@/integrations/schema";
import { serviceCiphertextSchema } from "@/integrations/schema";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";
import { fetchObserverAccounts, Sub2apiClientError } from "@/server/sub2api/client";
import { normalizeHealthCode } from "./health";
import { decryptServiceToken, encryptServiceToken } from "./service-cipher";

export { normalizeHealthCode } from "./health";

const maxPagesPerRun = 100;
const maxRunMilliseconds = 4 * 60 * 1000;

export type SyncTrigger = "scheduled" | "manual" | "test";

export class ConnectionSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ConnectionSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

type SyncConnectionRow = {
  id: string;
  ownerUserId: string;
  baseUrl: string;
  remoteInstanceId: string | null;
  tokenCiphertext: ServiceCiphertext;
  etag: string | null;
  enabled: boolean;
};

export async function syncSub2apiConnection(input: {
  connectionId: string;
  trigger: SyncTrigger;
  jobId?: string;
}): Promise<{ status: "succeeded" | "not_modified"; pages: number; accountsSeen: number; invalidItems: number }> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  const runId = randomUUID();
  const startedAt = new Date();
  await sql`
    insert into sync_runs (id, connection_id, trigger_type, status, started_at)
    values (${runId}, ${input.connectionId}, ${input.trigger}, 'running', ${startedAt})
  `;

  try {
    const [connection] = await sql<Array<SyncConnectionRow>>`
      select id, owner_user_id as "ownerUserId", base_url as "baseUrl",
        remote_instance_id as "remoteInstanceId", token_ciphertext as "tokenCiphertext",
        etag, enabled
      from sub2api_connections where id = ${input.connectionId} limit 1
    `;
    if (!connection) throw new ConnectionSyncError("CONNECTION_NOT_FOUND", "Connection no longer exists", false);
    if (!connection.enabled && input.trigger === "scheduled") {
      throw new ConnectionSyncError("CONNECTION_DISABLED", "Connection is disabled", false);
    }

    const token = await decryptServiceToken({
      connectionId: connection.id,
      ownerUserId: connection.ownerUserId,
      envelope: serviceCiphertextSchema.parse(connection.tokenCiphertext),
      config,
    });
    let cursor: string | null = null;
    let pages = 0;
    let accountsSeen = 0;
    let invalidItems = 0;
    let firstEtag: string | null = null;
    let instanceId: string | null = null;

    while (true) {
      if (pages >= maxPagesPerRun || Date.now() - startedAt.getTime() > maxRunMilliseconds) {
        throw new ConnectionSyncError("SYNC_LIMIT_EXCEEDED", "Sync run exceeded its safety limit", true);
      }
      const result = await fetchObserverAccounts({
        baseUrl: connection.baseUrl,
        token,
        cursor,
        etag: pages === 0 ? connection.etag : null,
        limit: 200,
      });
      if (result.status === "not_modified") {
        await markNotModified(sql, connection.id, runId, startedAt, result.etag ?? connection.etag);
        return { status: "not_modified", pages: 0, accountsSeen: 0, invalidItems: 0 };
      }
      pages += 1;
      firstEtag ??= result.etag;
      instanceId ??= result.page.instance_id;
      if (connection.remoteInstanceId && connection.remoteInstanceId !== result.page.instance_id) {
        throw new ConnectionSyncError("INSTANCE_ID_CHANGED", "Sub2API instance identity changed", false);
      }
      if (instanceId !== result.page.instance_id) {
        throw new ConnectionSyncError("INSTANCE_ID_CHANGED_DURING_SYNC", "Sub2API instance identity changed during pagination", false);
      }
      accountsSeen += result.page.items.length;
      invalidItems += result.page.invalidItems;
      if (result.page.invalidItems > 0 && result.page.invalidItems / Math.max(1, result.page.items.length + result.page.invalidItems) > 0.2) {
        throw new ConnectionSyncError("TOO_MANY_INVALID_ITEMS", "Observer returned too many invalid account items", false);
      }
      await persistObserverPage(sql, {
        ownerUserId: connection.ownerUserId,
        connectionId: connection.id,
        observedAt: startedAt,
        items: result.page.items,
      });
      cursor = result.page.next_cursor ?? null;
      if (!cursor) break;
    }

    await finalizeFullSync(sql, {
      connectionId: connection.id,
      ownerUserId: connection.ownerUserId,
      remoteInstanceId: instanceId,
      etag: firstEtag,
      runId,
      startedAt,
      pages,
      accountsSeen,
      invalidItems,
    });
    return { status: "succeeded", pages, accountsSeen, invalidItems };
  } catch (error) {
    const normalized = normalizeSyncError(error);
    await recordSyncFailure(sql, {
      connectionId: input.connectionId,
      runId,
      startedAt,
      code: normalized.code,
      summary: normalized.message,
    }).catch(() => undefined);
    throw normalized;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

async function persistObserverPage(
  sql: Sql,
  input: {
    ownerUserId: string;
    connectionId: string;
    observedAt: Date;
    items: ObserverAccount[];
  },
): Promise<void> {
  await sql.begin(async (transaction) => {
    for (const item of input.items) {
      const externalId = String(item.id);
      await transaction`
        insert into remote_account_catalog (
          id, connection_id, external_account_id, external_name, external_platform,
          external_type, remote_status, availability, available, quota,
          quota_error_code, sanitized_error_code, rate_limit_reset_at, overload_until,
          temp_unschedulable_until, remote_updated_at, last_seen_at, missing_full_syncs
        ) values (
          ${randomUUID()}, ${input.connectionId}, ${externalId}, ${item.name}, ${item.platform},
          ${item.type}, ${item.status}, ${item.availability}, ${item.available},
          ${item.quota ? transaction.json(item.quota) : null}, ${item.quota_error?.code ?? null},
          ${item.error_code ?? null}, ${item.rate_limit_reset_at ?? null}, ${item.overload_until ?? null},
          ${item.temp_unschedulable_until ?? null}, ${item.updated_at}, ${input.observedAt}, 0
        )
        on conflict (connection_id, external_account_id) do update
        set external_name = excluded.external_name,
            external_platform = excluded.external_platform,
            external_type = excluded.external_type,
            remote_status = excluded.remote_status,
            availability = excluded.availability,
            available = excluded.available,
            quota = coalesce(excluded.quota, remote_account_catalog.quota),
            quota_error_code = excluded.quota_error_code,
            sanitized_error_code = excluded.sanitized_error_code,
            rate_limit_reset_at = excluded.rate_limit_reset_at,
            overload_until = excluded.overload_until,
            temp_unschedulable_until = excluded.temp_unschedulable_until,
            remote_updated_at = excluded.remote_updated_at,
            last_seen_at = excluded.last_seen_at,
            missing_full_syncs = 0,
            updated_at = now()
      `;

      const links = await transaction<Array<{
        id: string; externalPlatform: string; previousHealth: string | null; unhealthyStreak: number;
      }>>`
        select l.id, l.external_platform as "externalPlatform", s.health_code as "previousHealth",
          coalesce(s.unhealthy_streak, 0) as "unhealthyStreak"
        from sub2api_account_links l
        left join sub2api_account_states s on s.link_id = l.id
        where l.connection_id = ${input.connectionId} and l.external_account_id = ${externalId}
        for update of l
      `;
      for (const link of links) {
        const platformMismatch = link.externalPlatform !== item.platform;
        const healthCode = platformMismatch ? "error" : normalizeHealthCode(item);
        const unhealthyStreak =
          healthCode === "healthy"
            ? 0
            : link.previousHealth === healthCode
              ? link.unhealthyStreak + 1
              : 1;
        await transaction`
          update sub2api_account_links
          set link_status = ${platformMismatch ? "platform_mismatch" : "linked"},
              last_seen_at = ${input.observedAt}, updated_at = now()
          where id = ${link.id}
        `;
        await transaction`
          insert into sub2api_account_states (
            link_id, health_code, sync_health, remote_status, availability, available,
            quota, quota_error_code, sanitized_error_code, observed_at, source_updated_at,
            unhealthy_streak, updated_at
          ) values (
            ${link.id}, ${healthCode}, 'fresh', ${item.status}, ${item.availability}, ${item.available},
            ${item.quota ? transaction.json(item.quota) : null}, ${item.quota_error?.code ?? null},
            ${item.error_code ?? null}, ${input.observedAt}, ${item.updated_at}, ${unhealthyStreak}, now()
          )
          on conflict (link_id) do update
          set health_code = excluded.health_code, sync_health = 'fresh',
              remote_status = excluded.remote_status, availability = excluded.availability,
              available = excluded.available,
              quota = coalesce(excluded.quota, sub2api_account_states.quota),
              quota_error_code = excluded.quota_error_code,
              sanitized_error_code = excluded.sanitized_error_code,
              observed_at = excluded.observed_at, source_updated_at = excluded.source_updated_at,
              unhealthy_streak = excluded.unhealthy_streak, updated_at = now()
        `;
        if (link.previousHealth !== healthCode) {
          await transaction`
            insert into account_state_events (
              id, owner_user_id, link_id, event_type, previous_health_code,
              health_code, metadata, observed_at
            ) values (
              ${randomUUID()}, ${input.ownerUserId}, ${link.id}, 'health.changed',
              ${link.previousHealth}, ${healthCode},
              ${transaction.json({ connectionId: input.connectionId, externalAccountId: externalId })},
              ${input.observedAt}
            )
          `;
        }
        await reconcileAlert(transaction, {
          ownerUserId: input.ownerUserId,
          linkId: link.id,
          healthCode,
          unhealthyStreak,
          observedAt: input.observedAt,
        });
      }
    }
  });
}

async function reconcileAlert(
  sql: Sql | TransactionSql,
  input: {
    ownerUserId: string;
    linkId: string;
    healthCode: string;
    unhealthyStreak: number;
    observedAt: Date;
  },
): Promise<void> {
  if (input.healthCode === "healthy") {
    await sql`
      update account_alerts
      set status = 'resolved', resolved_at = ${input.observedAt}, updated_at = now()
      where link_id = ${input.linkId} and status in ('firing', 'acknowledged')
    `;
    return;
  }
  if (input.healthCode === "unknown" || input.unhealthyStreak < 2) return;
  const dedupeKey = `health:${input.healthCode}`;
  await sql`
    insert into account_alerts (
      id, owner_user_id, link_id, dedupe_key, status, severity, health_code,
      summary, first_fired_at, last_fired_at
    ) values (
      ${randomUUID()}, ${input.ownerUserId}, ${input.linkId}, ${dedupeKey}, 'firing',
      ${alertSeverity(input.healthCode)}, ${input.healthCode}, ${alertSummary(input.healthCode)},
      ${input.observedAt}, ${input.observedAt}
    )
    on conflict (link_id, dedupe_key) where status in ('firing', 'acknowledged')
    do update set last_fired_at = excluded.last_fired_at,
      health_code = excluded.health_code, summary = excluded.summary, updated_at = now()
  `;
  await sql`
    update account_alerts
    set status = 'resolved', resolved_at = ${input.observedAt}, updated_at = now()
    where link_id = ${input.linkId}
      and status in ('firing', 'acknowledged')
      and dedupe_key <> ${dedupeKey}
  `;
}

async function finalizeFullSync(
  sql: Sql,
  input: {
    connectionId: string;
    ownerUserId: string;
    remoteInstanceId: string | null;
    etag: string | null;
    runId: string;
    startedAt: Date;
    pages: number;
    accountsSeen: number;
    invalidItems: number;
  },
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      update remote_account_catalog
      set missing_full_syncs = missing_full_syncs + 1, updated_at = now()
      where connection_id = ${input.connectionId} and last_seen_at < ${input.startedAt}
    `;
    await transaction`
      update sub2api_account_links l
      set link_status = case
            when c.missing_full_syncs >= 2 then 'missing'
            when l.external_platform <> c.external_platform then 'platform_mismatch'
            else l.link_status
          end,
          updated_at = now()
      from remote_account_catalog c
      where l.connection_id = ${input.connectionId}
        and c.connection_id = l.connection_id
        and c.external_account_id = l.external_account_id
    `;
    const missingLinks = await transaction<Array<{
      id: string; previousHealth: string | null; unhealthyStreak: number;
    }>>`
      select l.id, s.health_code as "previousHealth",
        coalesce(s.unhealthy_streak, 0) as "unhealthyStreak"
      from sub2api_account_links l
      join remote_account_catalog c
        on c.connection_id = l.connection_id and c.external_account_id = l.external_account_id
      left join sub2api_account_states s on s.link_id = l.id
      where l.connection_id = ${input.connectionId} and c.missing_full_syncs >= 2
      for update of l
    `;
    for (const link of missingLinks) {
      const unhealthyStreak = link.previousHealth === "missing"
        ? link.unhealthyStreak + 1
        : 2;
      await transaction`
        update sub2api_account_states
        set health_code = 'missing', sync_health = 'fresh', available = false,
            observed_at = ${input.startedAt}, unhealthy_streak = ${unhealthyStreak},
            updated_at = now()
        where link_id = ${link.id}
      `;
      if (link.previousHealth !== "missing") {
        await transaction`
          insert into account_state_events (
            id, owner_user_id, link_id, event_type, previous_health_code,
            health_code, metadata, observed_at
          ) values (
            ${randomUUID()}, ${input.ownerUserId}, ${link.id}, 'health.changed',
            ${link.previousHealth}, 'missing',
            ${transaction.json({ connectionId: input.connectionId, reason: "absent_from_two_full_syncs" })},
            ${input.startedAt}
          )
        `;
      }
      await reconcileAlert(transaction, {
        ownerUserId: input.ownerUserId,
        linkId: link.id,
        healthCode: "missing",
        unhealthyStreak,
        observedAt: input.startedAt,
      });
    }
    await transaction`
      update sub2api_connections
      set remote_instance_id = coalesce(remote_instance_id, ${input.remoteInstanceId}),
          etag = ${input.etag}, cursor = null, last_attempt_at = now(),
          last_success_at = now(), consecutive_failures = 0,
          last_error_code = null, last_error_summary = null, updated_at = now()
      where id = ${input.connectionId}
    `;
    await transaction`
      update sync_runs
      set status = 'succeeded', finished_at = now(), pages = ${input.pages},
          accounts_seen = ${input.accountsSeen}, items_failed = ${input.invalidItems}
      where id = ${input.runId}
    `;
  });
}

async function markNotModified(
  sql: Sql,
  connectionId: string,
  runId: string,
  startedAt: Date,
  etag: string | null,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      update sub2api_connections
      set etag = coalesce(${etag}, etag), last_attempt_at = now(), last_success_at = now(),
          consecutive_failures = 0, last_error_code = null, last_error_summary = null, updated_at = now()
      where id = ${connectionId}
    `;
    await transaction`
      update sub2api_account_states s set sync_health = 'fresh', updated_at = now()
      from sub2api_account_links l where l.id = s.link_id and l.connection_id = ${connectionId}
    `;
    await transaction`
      update sync_runs set status = 'not_modified', finished_at = now()
      where id = ${runId} and started_at = ${startedAt}
    `;
  });
}

async function recordSyncFailure(
  sql: Sql,
  input: {
    connectionId: string;
    runId: string;
    startedAt: Date;
    code: string;
    summary: string;
  },
): Promise<void> {
  await sql.begin(async (transaction) => {
    const [updated] = await transaction<Array<{ consecutiveFailures: number }>>`
      update sub2api_connections
      set last_attempt_at = now(), consecutive_failures = consecutive_failures + 1,
          last_error_code = ${input.code}, last_error_summary = ${input.summary}, updated_at = now()
      where id = ${input.connectionId}
      returning consecutive_failures as "consecutiveFailures"
    `;
    const syncHealth = (updated?.consecutiveFailures ?? 0) >= 3 ? "disconnected" : "stale";
    await transaction`
      update sub2api_account_states s
      set sync_health = case when observed_at is null then 'never_synced' else ${syncHealth} end,
          updated_at = now()
      from sub2api_account_links l
      where l.id = s.link_id and l.connection_id = ${input.connectionId}
    `;
    await transaction`
      update sync_runs
      set status = 'failed', finished_at = now(), error_code = ${input.code},
          error_summary = ${input.summary}
      where id = ${input.runId} and started_at = ${input.startedAt}
    `;
  });
}

export async function refreshStaleSyncHealth(): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql`
      update sub2api_account_states s
      set sync_health = case
        when c.last_success_at is null and c.consecutive_failures < 3 then 'never_synced'
        when c.consecutive_failures >= 3 or not c.enabled then 'disconnected'
        when c.last_success_at < now() - (c.sync_interval_seconds * 2 * interval '1 second') then 'stale'
        else 'fresh'
      end,
      updated_at = now()
      from sub2api_account_links l
      join sub2api_connections c on c.id = l.connection_id
      where l.id = s.link_id
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function cleanupIntegrationHistory(): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      await transaction`delete from sync_runs where started_at < now() - interval '90 days'`;
      await transaction`delete from account_state_events where created_at < now() - interval '180 days'`;
      await transaction`delete from account_alerts where status = 'resolved' and resolved_at < now() - interval '180 days'`;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function rotateServiceCiphertexts(): Promise<number> {
  const config = await readRuntimeConfig();
  const current = config.serviceEncryption.keys.find((key) => key.status === "current");
  if (!current) throw new Error("Current service encryption key is unavailable");
  const sql = createDatabaseClient(config.database, { max: 1 });
  let migrated = 0;
  try {
    const rows = await sql<Array<{
      id: string; ownerUserId: string; tokenCiphertext: ServiceCiphertext;
    }>>`
      select id, owner_user_id as "ownerUserId", token_ciphertext as "tokenCiphertext"
      from sub2api_connections where token_key_id <> ${current.id} order by id limit 100
    `;
    for (const row of rows) {
      const token = await decryptServiceToken({
        connectionId: row.id,
        ownerUserId: row.ownerUserId,
        envelope: row.tokenCiphertext,
        config,
      });
      const envelope = await encryptServiceToken({
        connectionId: row.id,
        ownerUserId: row.ownerUserId,
        token,
        config,
      });
      await sql`
        update sub2api_connections set token_ciphertext = ${sql.json(envelope)},
          token_key_id = ${envelope.keyId}, updated_at = now() where id = ${row.id}
      `;
      migrated += 1;
    }
    return migrated;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

function normalizeSyncError(error: unknown): ConnectionSyncError {
  if (error instanceof ConnectionSyncError) return error;
  if (error instanceof Sub2apiClientError) {
    return new ConnectionSyncError(error.code, error.message, error.retryable);
  }
  return new ConnectionSyncError("SYNC_FAILED", "Sub2API sync failed", true);
}

function alertSeverity(healthCode: string): "info" | "warning" | "critical" {
  return ["banned", "reauth_required", "error", "disabled"].includes(healthCode)
    ? "critical"
    : "warning";
}

function alertSummary(healthCode: string): string {
  const summaries: Record<string, string> = {
    disabled: "远端账号已停用",
    banned: "远端账号可能已被封禁",
    verification_required: "远端账号需要人工验证",
    reauth_required: "远端账号需要重新授权",
    error: "远端账号报告异常",
    temporarily_unavailable: "远端账号暂时不可调度",
    rate_limited: "远端账号处于限流窗口",
    overloaded: "远端账号处于过载窗口",
    paused: "远端账号已暂停调度",
    missing: "远端账号已连续两次未出现在完整目录中",
  };
  return summaries[healthCode] ?? "远端账号状态异常";
}
