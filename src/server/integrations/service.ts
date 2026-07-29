import { randomUUID } from "node:crypto";
import {
  serviceCiphertextSchema,
  type ConnectionSummary,
  type RemoteCatalogItem,
  type ServiceCiphertext,
} from "@/integrations/schema";
import { readRuntimeConfig, writeRuntimeConfig } from "@/runtime/config-store";
import { randomBase64Url } from "@/runtime/random";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";
import { hasRecentPasskeyStepUp } from "@/server/auth/step-up";
import { normalizeHealthCode } from "./health";
import { decryptServiceToken, encryptServiceToken } from "./service-cipher";
import {
  normalizeSub2apiBaseUrl,
  Sub2apiClientError,
  testSub2apiConnection,
} from "@/server/sub2api/client";

export class IntegrationServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "IntegrationServiceError";
    this.code = code;
    this.status = status;
  }
}

type ConnectionRow = {
  id: string;
  ownerUserId: string;
  name: string;
  baseUrl: string;
  remoteInstanceId: string | null;
  tokenCiphertext: ServiceCiphertext;
  tokenKeyId: string;
  tokenHint: string;
  syncIntervalSeconds: number;
  enabled: boolean;
  etag: string | null;
  cursor: string | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IntegrationLinkView = {
  id: string;
  managedAccountId: string;
  connectionId: string;
  connectionName: string;
  externalAccountId: string;
  externalName: string;
  externalPlatform: string;
  linkStatus: string;
  healthCode: string;
  syncHealth: string;
  remoteStatus: string | null;
  availability: string | null;
  available: boolean | null;
  quota: unknown;
  quotaErrorCode: string | null;
  observedAt: string | null;
  sourceUpdatedAt: string | null;
};

export type IntegrationAlertView = {
  id: string;
  linkId: string;
  managedAccountId: string;
  accountName: string;
  connectionName: string;
  status: "firing" | "acknowledged" | "resolved";
  severity: "info" | "warning" | "critical";
  healthCode: string;
  summary: string;
  firstFiredAt: string;
  lastFiredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

export async function requireRecentIntegrationStepUp(input: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  if (!(await hasRecentPasskeyStepUp(input))) {
    throw new IntegrationServiceError(
      "PASSKEY_STEP_UP_REQUIRED",
      "Recent Passkey verification is required",
      403,
    );
  }
}

export async function rotateServiceKeyRing(input: {
  ownerUserId: string;
  sessionId: string;
  requestId?: string;
}): Promise<{ currentKeyId: string; previousKeyId: string }> {
  await requireRecentIntegrationStepUp({ sessionId: input.sessionId, userId: input.ownerUserId });
  const config = await readRuntimeConfig();
  const current = config.serviceEncryption.keys.find((key) => key.status === "current");
  if (!current) throw new IntegrationServiceError("SERVICE_KEY_UNAVAILABLE", "Current service key is unavailable", 503);
  const previous = config.serviceEncryption.keys.find((key) => key.status === "previous");
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    if (previous) {
      const [usage] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from sub2api_connections where token_key_id = ${previous.id}
      `;
      if ((usage?.count ?? 0) > 0) {
        throw new IntegrationServiceError(
          "SERVICE_KEY_ROTATION_PENDING",
          "Previous service key still protects connection tokens",
          409,
        );
      }
    }
    const nextId = `service-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    await writeRuntimeConfig({
      ...config,
      serviceEncryption: {
        keys: [
          { id: nextId, key: randomBase64Url(32), status: "current" },
          { ...current, status: "previous" },
        ],
      },
      updatedAt: new Date().toISOString(),
    });
    await sql`
      insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
      values (${randomUUID()}, ${input.ownerUserId}, 'service_key.rotated', 'success',
        ${input.requestId ?? null}, ${sql.json({ currentKeyId: nextId, previousKeyId: current.id })})
    `;
    return { currentKeyId: nextId, previousKeyId: current.id };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function listConnections(ownerUserId: string): Promise<ConnectionSummary[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<Array<ConnectionRow>>`
      select id, owner_user_id as "ownerUserId", name, base_url as "baseUrl",
        remote_instance_id as "remoteInstanceId", token_ciphertext as "tokenCiphertext",
        token_key_id as "tokenKeyId", token_hint as "tokenHint",
        sync_interval_seconds as "syncIntervalSeconds", enabled, etag, cursor,
        last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt",
        consecutive_failures as "consecutiveFailures", last_error_code as "lastErrorCode",
        last_error_summary as "lastErrorSummary", created_at as "createdAt",
        updated_at as "updatedAt"
      from sub2api_connections
      where owner_user_id = ${ownerUserId}
      order by name asc, id asc
    `;
    const now = new Date();
    return rows.map((row) => connectionSummary(row, now));
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function createConnection(input: {
  ownerUserId: string;
  sessionId: string;
  name: string;
  baseUrl: string;
  token: string;
  syncIntervalSeconds: number;
  requestId?: string;
}): Promise<{ connection: ConnectionSummary; test: Awaited<ReturnType<typeof testSub2apiConnection>> }> {
  await requireRecentIntegrationStepUp({ sessionId: input.sessionId, userId: input.ownerUserId });
  const config = await readRuntimeConfig();
  const id = randomUUID();
  const baseUrl = normalizeSub2apiBaseUrl(input.baseUrl);
  const token = input.token.trim();
  const test = await testSub2apiConnection({ baseUrl, token });
  if (test.schemaVersion !== 1) {
    throw new IntegrationServiceError("OBSERVER_SCHEMA_UNSUPPORTED", "Observer schema version is unsupported");
  }
  const tokenCiphertext = await encryptServiceToken({
    connectionId: id,
    ownerUserId: input.ownerUserId,
    token,
    config,
  });
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const row = await sql.begin(async (transaction) => {
      const [created] = await transaction<Array<ConnectionRow>>`
        insert into sub2api_connections (
          id, owner_user_id, name, base_url, remote_instance_id,
          token_ciphertext, token_key_id, token_hint, sync_interval_seconds
        ) values (
          ${id}, ${input.ownerUserId}, ${input.name.trim()}, ${baseUrl}, ${test.instanceId},
          ${transaction.json(tokenCiphertext)}, ${tokenCiphertext.keyId}, ${tokenHint(token)},
          ${input.syncIntervalSeconds}
        )
        returning id, owner_user_id as "ownerUserId", name, base_url as "baseUrl",
          remote_instance_id as "remoteInstanceId", token_ciphertext as "tokenCiphertext",
          token_key_id as "tokenKeyId", token_hint as "tokenHint",
          sync_interval_seconds as "syncIntervalSeconds", enabled, etag, cursor,
          last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt",
          consecutive_failures as "consecutiveFailures", last_error_code as "lastErrorCode",
          last_error_summary as "lastErrorSummary", created_at as "createdAt",
          updated_at as "updatedAt"
      `;
      if (!created) throw new Error("Connection was not created");
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
        values (${randomUUID()}, ${input.ownerUserId}, 'sub2api.connection.created', 'success',
          ${input.requestId ?? null}, ${transaction.json({ connectionId: id, instanceId: test.instanceId })})
      `;
      return created;
    });
    return { connection: connectionSummary(row, new Date()), test };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new IntegrationServiceError("CONNECTION_CONFLICT", "A connection with this name already exists", 409);
    }
    throw error;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function updateConnection(input: {
  id: string;
  ownerUserId: string;
  sessionId: string;
  name?: string;
  token?: string;
  syncIntervalSeconds?: number;
  enabled?: boolean;
  requestId?: string;
}): Promise<ConnectionSummary> {
  if (input.token !== undefined) {
    await requireRecentIntegrationStepUp({ sessionId: input.sessionId, userId: input.ownerUserId });
  }
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const existing = await getConnectionRow(sql, input.ownerUserId, input.id);
    if (!existing) throw new IntegrationServiceError("CONNECTION_NOT_FOUND", "Connection was not found", 404);

    let tokenCiphertext = existing.tokenCiphertext;
    let tokenKeyId = existing.tokenKeyId;
    let hint = existing.tokenHint;
    if (input.token !== undefined) {
      const token = input.token.trim();
      await testSub2apiConnection({
        baseUrl: existing.baseUrl,
        token,
        expectedInstanceId: existing.remoteInstanceId,
      });
      tokenCiphertext = await encryptServiceToken({
        connectionId: existing.id,
        ownerUserId: input.ownerUserId,
        token,
        config,
      });
      tokenKeyId = tokenCiphertext.keyId;
      hint = tokenHint(token);
    }
    const [updated] = await sql<Array<ConnectionRow>>`
      update sub2api_connections
      set name = ${input.name?.trim() ?? existing.name},
          token_ciphertext = ${sql.json(tokenCiphertext)},
          token_key_id = ${tokenKeyId},
          token_hint = ${hint},
          sync_interval_seconds = ${input.syncIntervalSeconds ?? existing.syncIntervalSeconds},
          enabled = ${input.enabled ?? existing.enabled},
          consecutive_failures = case when ${input.token !== undefined} then 0 else consecutive_failures end,
          last_error_code = case when ${input.token !== undefined} then null else last_error_code end,
          last_error_summary = case when ${input.token !== undefined} then null else last_error_summary end,
          updated_at = now()
      where id = ${input.id} and owner_user_id = ${input.ownerUserId}
      returning id, owner_user_id as "ownerUserId", name, base_url as "baseUrl",
        remote_instance_id as "remoteInstanceId", token_ciphertext as "tokenCiphertext",
        token_key_id as "tokenKeyId", token_hint as "tokenHint",
        sync_interval_seconds as "syncIntervalSeconds", enabled, etag, cursor,
        last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt",
        consecutive_failures as "consecutiveFailures", last_error_code as "lastErrorCode",
        last_error_summary as "lastErrorSummary", created_at as "createdAt",
        updated_at as "updatedAt"
    `;
    if (!updated) throw new IntegrationServiceError("CONNECTION_NOT_FOUND", "Connection was not found", 404);
    await sql`
      insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
      values (${randomUUID()}, ${input.ownerUserId}, 'sub2api.connection.updated', 'success',
        ${input.requestId ?? null}, ${sql.json({ connectionId: input.id, tokenReplaced: input.token !== undefined })})
    `;
    return connectionSummary(updated, new Date());
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function deleteConnection(input: {
  id: string;
  ownerUserId: string;
  sessionId: string;
  requestId?: string;
}): Promise<void> {
  await requireRecentIntegrationStepUp({ sessionId: input.sessionId, userId: input.ownerUserId });
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      const deleted = await transaction`
        delete from sub2api_connections
        where id = ${input.id} and owner_user_id = ${input.ownerUserId}
      `;
      if (deleted.count === 0) {
        throw new IntegrationServiceError("CONNECTION_NOT_FOUND", "Connection was not found", 404);
      }
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
        values (${randomUUID()}, ${input.ownerUserId}, 'sub2api.connection.deleted', 'success',
          ${input.requestId ?? null}, ${transaction.json({ connectionId: input.id })})
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function testStoredConnection(input: {
  id: string;
  ownerUserId: string;
}) {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const row = await getConnectionRow(sql, input.ownerUserId, input.id);
    if (!row) throw new IntegrationServiceError("CONNECTION_NOT_FOUND", "Connection was not found", 404);
    const token = await decryptServiceToken({
      connectionId: row.id,
      ownerUserId: row.ownerUserId,
      envelope: serviceCiphertextSchema.parse(row.tokenCiphertext),
      config,
    });
    const result = await testSub2apiConnection({
      baseUrl: row.baseUrl,
      token,
      expectedInstanceId: row.remoteInstanceId,
    });
    await sql`
      update sub2api_connections
      set last_error_code = null, last_error_summary = null, updated_at = now()
      where id = ${row.id}
    `;
    return result;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function listRemoteCatalog(input: {
  ownerUserId: string;
  connectionId: string;
}): Promise<RemoteCatalogItem[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<Array<{
      connectionId: string; externalAccountId: string; externalName: string;
      externalPlatform: string; externalType: string; remoteStatus: string;
      availability: string; available: boolean; quota: unknown; quotaErrorCode: string | null;
      remoteUpdatedAt: Date; lastSeenAt: Date; linkedManagedAccountId: string | null;
    }>>`
      select c.connection_id as "connectionId", c.external_account_id as "externalAccountId",
        c.external_name as "externalName", c.external_platform as "externalPlatform",
        c.external_type as "externalType", c.remote_status as "remoteStatus",
        c.availability, c.available, c.quota, c.quota_error_code as "quotaErrorCode",
        c.remote_updated_at as "remoteUpdatedAt", c.last_seen_at as "lastSeenAt",
        l.managed_account_id as "linkedManagedAccountId"
      from remote_account_catalog c
      join sub2api_connections conn on conn.id = c.connection_id and conn.owner_user_id = ${input.ownerUserId}
      left join sub2api_account_links l
        on l.connection_id = c.connection_id and l.external_account_id = c.external_account_id
      where c.connection_id = ${input.connectionId}
      order by c.external_platform, lower(c.external_name), c.external_account_id
    `;
    return rows.map((row) => ({
      ...row,
      quota: row.quota as RemoteCatalogItem["quota"],
      remoteUpdatedAt: row.remoteUpdatedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function createAccountLink(input: {
  ownerUserId: string;
  managedAccountId: string;
  connectionId: string;
  externalAccountId: string;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      const [candidate] = await transaction<Array<{
        externalPlatform: string; lastSeenAt: Date; managedPlatform: string;
        remoteStatus: string; availability: string; available: boolean;
        quota: unknown; quotaErrorCode: string | null; sanitizedErrorCode: string | null;
        remoteUpdatedAt: Date; connectionEnabled: boolean; lastSuccessAt: Date | null;
        consecutiveFailures: number; syncIntervalSeconds: number;
      }>>`
        select c.external_platform as "externalPlatform", c.last_seen_at as "lastSeenAt",
          m.platform as "managedPlatform", c.remote_status as "remoteStatus",
          c.availability, c.available, c.quota, c.quota_error_code as "quotaErrorCode",
          c.sanitized_error_code as "sanitizedErrorCode",
          c.remote_updated_at as "remoteUpdatedAt", conn.enabled as "connectionEnabled",
          conn.last_success_at as "lastSuccessAt",
          conn.consecutive_failures as "consecutiveFailures",
          conn.sync_interval_seconds as "syncIntervalSeconds"
        from remote_account_catalog c
        join sub2api_connections conn on conn.id = c.connection_id
        join managed_accounts m on m.id = ${input.managedAccountId} and m.owner_user_id = ${input.ownerUserId} and m.deleted_at is null
        where c.connection_id = ${input.connectionId}
          and c.external_account_id = ${input.externalAccountId}
          and conn.owner_user_id = ${input.ownerUserId}
        limit 1
        for update of m
      `;
      if (!candidate) throw new IntegrationServiceError("LINK_CANDIDATE_NOT_FOUND", "Remote or managed account was not found", 404);
      if (candidate.externalPlatform !== candidate.managedPlatform) {
        throw new IntegrationServiceError("LINK_PLATFORM_MISMATCH", "Remote and managed account platforms do not match", 409);
      }
      const linkId = randomUUID();
      const healthCode = normalizeHealthCode({
        status: candidate.remoteStatus,
        availability: candidate.availability,
        available: candidate.available,
        error_code: candidate.sanitizedErrorCode ?? undefined,
      });
      const syncHealth = calculateSyncHealth({
        enabled: candidate.connectionEnabled,
        lastSuccessAt: candidate.lastSuccessAt,
        consecutiveFailures: candidate.consecutiveFailures,
        syncIntervalSeconds: candidate.syncIntervalSeconds,
        now: new Date(),
      });
      await transaction`
        insert into sub2api_account_links (
          id, owner_user_id, managed_account_id, connection_id,
          external_account_id, external_platform, last_seen_at
        ) values (
          ${linkId}, ${input.ownerUserId}, ${input.managedAccountId}, ${input.connectionId},
          ${input.externalAccountId}, ${candidate.externalPlatform}, ${candidate.lastSeenAt}
        )
      `;
      await transaction`
        insert into sub2api_account_states (
          link_id, health_code, sync_health, remote_status, availability, available,
          quota, quota_error_code, sanitized_error_code, observed_at, source_updated_at,
          unhealthy_streak
        ) values (
          ${linkId}, ${healthCode}, ${syncHealth}, ${candidate.remoteStatus},
          ${candidate.availability}, ${candidate.available},
          ${candidate.quota ? transaction.json(candidate.quota as never) : null},
          ${candidate.quotaErrorCode}, ${candidate.sanitizedErrorCode},
          ${candidate.lastSeenAt}, ${candidate.remoteUpdatedAt},
          ${healthCode === "healthy" ? 0 : 1}
        )
      `;
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
        values (${randomUUID()}, ${input.ownerUserId}, 'sub2api.link.created', 'success',
          ${input.requestId ?? null}, ${transaction.json({ linkId, managedAccountId: input.managedAccountId, connectionId: input.connectionId, externalAccountId: input.externalAccountId })})
      `;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new IntegrationServiceError("LINK_CONFLICT", "This remote or managed account is already linked", 409);
    }
    throw error;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function deleteAccountLink(input: {
  ownerUserId: string;
  linkId: string;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const result = await sql`
      delete from sub2api_account_links
      where id = ${input.linkId} and owner_user_id = ${input.ownerUserId}
    `;
    if (result.count === 0) throw new IntegrationServiceError("LINK_NOT_FOUND", "Link was not found", 404);
    await sql`
      insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
      values (${randomUUID()}, ${input.ownerUserId}, 'sub2api.link.deleted', 'success',
        ${input.requestId ?? null}, ${sql.json({ linkId: input.linkId })})
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function listAccountLinks(input: {
  ownerUserId: string;
  managedAccountId?: string;
}): Promise<IntegrationLinkView[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<Array<{
      id: string; managedAccountId: string; connectionId: string; connectionName: string;
      externalAccountId: string; externalName: string; externalPlatform: string; linkStatus: string;
      healthCode: string; syncHealth: string; remoteStatus: string | null;
      availability: string | null; available: boolean | null;
      quota: unknown; quotaErrorCode: string | null; observedAt: Date | null; sourceUpdatedAt: Date | null;
    }>>`
      select l.id, l.managed_account_id as "managedAccountId", l.connection_id as "connectionId",
        conn.name as "connectionName", l.external_account_id as "externalAccountId",
        coalesce(c.external_name, l.external_account_id) as "externalName",
        l.external_platform as "externalPlatform", l.link_status as "linkStatus",
        coalesce(s.health_code, 'unknown') as "healthCode",
        coalesce(s.sync_health, 'never_synced') as "syncHealth",
        s.remote_status as "remoteStatus", s.availability,
        s.available, s.quota, s.quota_error_code as "quotaErrorCode",
        s.observed_at as "observedAt", s.source_updated_at as "sourceUpdatedAt"
      from sub2api_account_links l
      join sub2api_connections conn on conn.id = l.connection_id
      left join remote_account_catalog c on c.connection_id = l.connection_id and c.external_account_id = l.external_account_id
      left join sub2api_account_states s on s.link_id = l.id
      where l.owner_user_id = ${input.ownerUserId}
        and (${input.managedAccountId ?? null}::text is null or l.managed_account_id = ${input.managedAccountId ?? null})
      order by conn.name, c.external_name nulls last
    `;
    return rows.map((row) => ({
      ...row,
      observedAt: row.observedAt?.toISOString() ?? null,
      sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    }));
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function listAlerts(ownerUserId: string): Promise<IntegrationAlertView[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<Array<{
      id: string; linkId: string; managedAccountId: string; accountName: string;
      connectionName: string; status: IntegrationAlertView["status"];
      severity: IntegrationAlertView["severity"]; healthCode: string; summary: string;
      firstFiredAt: Date; lastFiredAt: Date; acknowledgedAt: Date | null; resolvedAt: Date | null;
    }>>`
      select a.id, a.link_id as "linkId", l.managed_account_id as "managedAccountId",
        m.display_name as "accountName", c.name as "connectionName", a.status, a.severity,
        a.health_code as "healthCode", a.summary, a.first_fired_at as "firstFiredAt",
        a.last_fired_at as "lastFiredAt", a.acknowledged_at as "acknowledgedAt",
        a.resolved_at as "resolvedAt"
      from account_alerts a
      join sub2api_account_links l on l.id = a.link_id
      join managed_accounts m on m.id = l.managed_account_id
      join sub2api_connections c on c.id = l.connection_id
      where a.owner_user_id = ${ownerUserId}
      order by (a.status = 'resolved'), a.last_fired_at desc
      limit 200
    `;
    return rows.map((row) => ({
      ...row,
      firstFiredAt: row.firstFiredAt.toISOString(),
      lastFiredAt: row.lastFiredAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function acknowledgeAlert(input: {
  ownerUserId: string;
  alertId: string;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const result = await sql`
      update account_alerts
      set status = 'acknowledged', acknowledged_at = now(),
        acknowledged_by = ${input.ownerUserId}, updated_at = now()
      where id = ${input.alertId} and owner_user_id = ${input.ownerUserId} and status = 'firing'
    `;
    if (result.count === 0) throw new IntegrationServiceError("ALERT_NOT_ACKNOWLEDGEABLE", "Alert is no longer firing", 409);
    await sql`
      insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
      values (${randomUUID()}, ${input.ownerUserId}, 'alert.acknowledged', 'success',
        ${input.requestId ?? null}, ${sql.json({ alertId: input.alertId })})
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function getWorkerDiagnostic() {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const [heartbeat] = await sql<Array<{
      releaseId: string; processId: number; status: string; details: unknown;
      heartbeatAt: Date; startedAt: Date;
    }>>`
      select release_id as "releaseId", process_id as "processId", status, details,
        heartbeat_at as "heartbeatAt", started_at as "startedAt"
      from worker_heartbeats where component = 'sync-worker' limit 1
    `;
    return heartbeat
      ? {
          ...heartbeat,
          heartbeatAt: heartbeat.heartbeatAt.toISOString(),
          startedAt: heartbeat.startedAt.toISOString(),
          healthy: Date.now() - heartbeat.heartbeatAt.getTime() < 90_000,
        }
      : null;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export function calculateSyncHealth(input: {
  enabled: boolean;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  syncIntervalSeconds: number;
  now: Date;
}): ConnectionSummary["syncHealth"] {
  if (!input.lastSuccessAt) return input.consecutiveFailures >= 3 ? "disconnected" : "never_synced";
  if (!input.enabled || input.consecutiveFailures >= 3) return "disconnected";
  const age = input.now.getTime() - input.lastSuccessAt.getTime();
  return age <= input.syncIntervalSeconds * 2 * 1000 ? "fresh" : "stale";
}

function connectionSummary(row: ConnectionRow, now: Date): ConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    remoteInstanceId: row.remoteInstanceId,
    tokenHint: row.tokenHint,
    tokenKeyId: row.tokenKeyId,
    syncIntervalSeconds: row.syncIntervalSeconds,
    enabled: row.enabled,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastErrorCode: row.lastErrorCode,
    lastErrorSummary: row.lastErrorSummary,
    syncHealth: calculateSyncHealth({ ...row, now }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getConnectionRow(
  sql: ReturnType<typeof createDatabaseClient>,
  ownerUserId: string,
  id: string,
): Promise<ConnectionRow | null> {
  const [row] = await sql<Array<ConnectionRow>>`
    select id, owner_user_id as "ownerUserId", name, base_url as "baseUrl",
      remote_instance_id as "remoteInstanceId", token_ciphertext as "tokenCiphertext",
      token_key_id as "tokenKeyId", token_hint as "tokenHint",
      sync_interval_seconds as "syncIntervalSeconds", enabled, etag, cursor,
      last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt",
      consecutive_failures as "consecutiveFailures", last_error_code as "lastErrorCode",
      last_error_summary as "lastErrorSummary", created_at as "createdAt",
      updated_at as "updatedAt"
    from sub2api_connections
    where id = ${id} and owner_user_id = ${ownerUserId}
    limit 1
  `;
  return row ?? null;
}

function tokenHint(token: string): string {
  const prefix = token.slice(0, Math.min(6, token.length));
  const suffix = token.slice(-4);
  return `${prefix}...${suffix}`;
}

export function integrationError(error: unknown): IntegrationServiceError {
  if (error instanceof IntegrationServiceError) return error;
  if (error instanceof Sub2apiClientError) {
    return new IntegrationServiceError(error.code, error.message, error.status ?? 502);
  }
  return new IntegrationServiceError("INTEGRATION_UNAVAILABLE", "Integration service is unavailable", 503);
}
