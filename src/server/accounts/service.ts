import { randomUUID } from "node:crypto";
import {
  managedAccountSchema,
  type AccountLocalStatus,
  type AccountPlatform,
  type ManagedAccount,
} from "@/accounts/schema";
import type { EncryptedEnvelope } from "@/crypto/schema";
import { serviceCiphertextSchema, type ServiceCiphertext } from "@/integrations/schema";
import { readRuntimeConfig } from "@/runtime/config-store";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "@/server/database/connection";
import { decryptServiceToken } from "@/server/integrations/service-cipher";
import {
  deleteObserverAccount,
  Sub2apiClientError,
} from "@/server/sub2api/client";

export class ManagedAccountServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ManagedAccountServiceError";
    this.code = code;
    this.status = status;
  }
}

type ManagedAccountRow = {
  id: string;
  ownerUserId: string;
  platform: AccountPlatform;
  displayName: string;
  privatePayload: EncryptedEnvelope;
  emailBlindIndex: string | null;
  emailDomainBlindIndex: string | null;
  hasTotp: boolean;
  localStatus: AccountLocalStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ManagedAccountList = {
  items: ManagedAccount[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

function parseRow(row: ManagedAccountRow): ManagedAccount {
  return managedAccountSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function listManagedAccounts(input: {
  ownerUserId: string;
  page: number;
  pageSize: number;
  search?: string;
  platform?: AccountPlatform;
  localStatus?: AccountLocalStatus;
  hasTotp?: boolean;
  includeDeleted?: boolean;
  emailBlindIndex?: string;
  emailDomainBlindIndex?: string;
}): Promise<ManagedAccountList> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  const search = input.search ? `%${escapeLike(input.search.trim())}%` : null;
  const platform = input.platform ?? null;
  const localStatus = input.localStatus ?? "active";
  const hasTotp = input.hasTotp ?? null;
  const includeDeleted = input.includeDeleted ?? false;
  const emailBlindIndex = input.emailBlindIndex ?? null;
  const emailDomainBlindIndex = input.emailDomainBlindIndex ?? null;
  const offset = (input.page - 1) * input.pageSize;
  try {
    const [rows, totals] = await Promise.all([
      sql<Array<ManagedAccountRow>>`
        select
          id,
          owner_user_id as "ownerUserId",
          platform,
          display_name as "displayName",
          private_payload as "privatePayload",
          email_blind_index as "emailBlindIndex",
          email_domain_blind_index as "emailDomainBlindIndex",
          has_totp as "hasTotp",
          local_status as "localStatus",
          revision,
          created_at as "createdAt",
          updated_at as "updatedAt"
        from managed_accounts
        where owner_user_id = ${input.ownerUserId}
          and (${includeDeleted}::boolean or deleted_at is null)
          and local_status = ${localStatus}
          and (${platform}::text is null or platform = ${platform})
          and (${hasTotp}::boolean is null or has_totp = ${hasTotp})
          and (
            (${search}::text is null and ${emailBlindIndex}::text is null)
            or (${search}::text is not null and display_name ilike ${search} escape '\\')
            or (${emailBlindIndex}::text is not null and email_blind_index = ${emailBlindIndex})
          )
          and (${emailDomainBlindIndex}::text is null or email_domain_blind_index = ${emailDomainBlindIndex})
        order by updated_at desc, id desc
        limit ${input.pageSize}
        offset ${offset}
      `,
      sql<Array<{ total: number }>>`
        select count(*)::int as total
        from managed_accounts
        where owner_user_id = ${input.ownerUserId}
          and (${includeDeleted}::boolean or deleted_at is null)
          and local_status = ${localStatus}
          and (${platform}::text is null or platform = ${platform})
          and (${hasTotp}::boolean is null or has_totp = ${hasTotp})
          and (
            (${search}::text is null and ${emailBlindIndex}::text is null)
            or (${search}::text is not null and display_name ilike ${search} escape '\\')
            or (${emailBlindIndex}::text is not null and email_blind_index = ${emailBlindIndex})
          )
          and (${emailDomainBlindIndex}::text is null or email_domain_blind_index = ${emailDomainBlindIndex})
      `,
    ]);
    const total = totals[0]?.total ?? 0;
    return {
      items: rows.map(parseRow),
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / input.pageSize)),
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function getManagedAccount(
  ownerUserId: string,
  accountId: string,
): Promise<ManagedAccount | null> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const [row] = await sql<Array<ManagedAccountRow>>`
      select
        id,
        owner_user_id as "ownerUserId",
        platform,
        display_name as "displayName",
        private_payload as "privatePayload",
        email_blind_index as "emailBlindIndex",
        email_domain_blind_index as "emailDomainBlindIndex",
        has_totp as "hasTotp",
        local_status as "localStatus",
        revision,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from managed_accounts
      where id = ${accountId}
        and owner_user_id = ${ownerUserId}
        and deleted_at is null
      limit 1
    `;
    return row ? parseRow(row) : null;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function createManagedAccount(input: {
  id: string;
  ownerUserId: string;
  platform: AccountPlatform;
  displayName: string;
  privatePayload: EncryptedEnvelope;
  emailBlindIndex: string | null;
  emailDomainBlindIndex: string | null;
  hasTotp: boolean;
  requestId?: string;
}): Promise<ManagedAccount> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [created] = await transaction<Array<ManagedAccountRow>>`
        insert into managed_accounts (
          id,
          owner_user_id,
          platform,
          display_name,
          private_payload,
          email_blind_index,
          email_domain_blind_index,
          has_totp
        ) values (
          ${input.id},
          ${input.ownerUserId},
          ${input.platform},
          ${input.displayName},
          ${transaction.json(input.privatePayload)},
          ${input.emailBlindIndex},
          ${input.emailDomainBlindIndex},
          ${input.hasTotp}
        )
        returning
          id,
          owner_user_id as "ownerUserId",
          platform,
          display_name as "displayName",
          private_payload as "privatePayload",
          email_blind_index as "emailBlindIndex",
          email_domain_blind_index as "emailDomainBlindIndex",
          has_totp as "hasTotp",
          local_status as "localStatus",
          revision,
          created_at as "createdAt",
          updated_at as "updatedAt"
      `;
      if (!created) {
        throw new ManagedAccountServiceError(
          "ACCOUNT_CREATE_FAILED",
          "Managed account could not be created",
        );
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'managed_account.created',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.id })}
        )
      `;
      return parseRow(created);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ManagedAccountServiceError(
        "ACCOUNT_CONFLICT",
        "Managed account already exists",
      );
    }
    throw error;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function batchCreateManagedAccounts(input: {
  ownerUserId: string;
  accounts: Array<{
    id: string;
    platform: AccountPlatform;
    displayName: string;
    privatePayload: EncryptedEnvelope;
    emailBlindIndex: string | null;
    emailDomainBlindIndex: string | null;
    hasTotp: boolean;
  }>;
  requestId?: string;
}): Promise<{ created: ManagedAccount[]; count: number }> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const createdList: ManagedAccount[] = [];
      for (const account of input.accounts) {
        const [created] = await transaction<Array<ManagedAccountRow>>`
          insert into managed_accounts (
            id,
            owner_user_id,
            platform,
            display_name,
            private_payload,
            email_blind_index,
            email_domain_blind_index,
            has_totp
          ) values (
            ${account.id},
            ${input.ownerUserId},
            ${account.platform},
            ${account.displayName},
            ${transaction.json(account.privatePayload)},
            ${account.emailBlindIndex},
            ${account.emailDomainBlindIndex},
            ${account.hasTotp}
          )
          returning
            id,
            owner_user_id as "ownerUserId",
            platform,
            display_name as "displayName",
            private_payload as "privatePayload",
            email_blind_index as "emailBlindIndex",
            email_domain_blind_index as "emailDomainBlindIndex",
            has_totp as "hasTotp",
            local_status as "localStatus",
            revision,
            created_at as "createdAt",
            updated_at as "updatedAt"
        `;
        if (created) {
          createdList.push(parseRow(created));
        }
      }

      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'managed_account.batch_created',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ count: createdList.length, accountIds: createdList.map((a) => a.id) })}
        )
      `;

      return { created: createdList, count: createdList.length };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ManagedAccountServiceError(
        "ACCOUNT_CONFLICT",
        "One or more managed accounts already exist in batch",
      );
    }
    throw error;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function updateManagedAccount(input: {
  id: string;
  ownerUserId: string;
  expectedRevision: number;
  platform: AccountPlatform;
  displayName: string;
  privatePayload: EncryptedEnvelope;
  emailBlindIndex: string | null;
  emailDomainBlindIndex: string | null;
  hasTotp: boolean;
  localStatus: AccountLocalStatus;
  requestId?: string;
}): Promise<ManagedAccount> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [updated] = await transaction<Array<ManagedAccountRow>>`
        update managed_accounts
        set platform = ${input.platform},
            display_name = ${input.displayName},
            private_payload = ${transaction.json(input.privatePayload)},
            email_blind_index = ${input.emailBlindIndex},
            email_domain_blind_index = ${input.emailDomainBlindIndex},
            has_totp = ${input.hasTotp},
            local_status = ${input.localStatus},
            revision = revision + 1,
            updated_at = now()
        where id = ${input.id}
          and owner_user_id = ${input.ownerUserId}
          and revision = ${input.expectedRevision}
          and deleted_at is null
        returning
          id,
          owner_user_id as "ownerUserId",
          platform,
          display_name as "displayName",
          private_payload as "privatePayload",
          email_blind_index as "emailBlindIndex",
          email_domain_blind_index as "emailDomainBlindIndex",
          has_totp as "hasTotp",
          local_status as "localStatus",
          revision,
          created_at as "createdAt",
          updated_at as "updatedAt"
      `;
      if (!updated) {
        throw new ManagedAccountServiceError(
          "ACCOUNT_REVISION_CONFLICT",
          "Account changed in another session or no longer exists",
        );
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'managed_account.updated',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.id })}
        )
      `;
      return parseRow(updated);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function deleteManagedAccount(input: {
  id: string;
  ownerUserId: string;
  expectedRevision: number;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      const [account] = await transaction<Array<{ id: string }>>`
        select id
        from managed_accounts
        where id = ${input.id}
          and owner_user_id = ${input.ownerUserId}
          and revision = ${input.expectedRevision}
          and deleted_at is null
        limit 1
        for update
      `;
      if (!account) {
        throw new ManagedAccountServiceError(
          "ACCOUNT_REVISION_CONFLICT",
          "Account changed in another session or no longer exists",
        );
      }

      const remoteAccounts = await transaction<Array<{
        connectionId: string;
        baseUrl: string;
        externalAccountId: string;
        tokenCiphertext: ServiceCiphertext;
      }>>`
        select
          conn.id as "connectionId",
          conn.base_url as "baseUrl",
          link.external_account_id as "externalAccountId",
          conn.token_ciphertext as "tokenCiphertext"
        from sub2api_account_links link
        join sub2api_connections conn
          on conn.id = link.connection_id
          and conn.owner_user_id = ${input.ownerUserId}
        where link.managed_account_id = ${input.id}
          and link.owner_user_id = ${input.ownerUserId}
        order by conn.id, link.external_account_id
      `;

      const deletionTargets = [];
      for (const remoteAccount of remoteAccounts) {
        try {
          deletionTargets.push({
            baseUrl: remoteAccount.baseUrl,
            token: await decryptServiceToken({
              connectionId: remoteAccount.connectionId,
              ownerUserId: input.ownerUserId,
              envelope: serviceCiphertextSchema.parse(remoteAccount.tokenCiphertext),
              config,
            }),
            accountId: remoteAccount.externalAccountId,
          });
        } catch {
          throw new ManagedAccountServiceError(
            "SUB2API_DELETE_CREDENTIAL_UNAVAILABLE",
            "Sub2API deletion credential is unavailable",
            503,
          );
        }
      }

      const remoteResults = await Promise.allSettled(
        deletionTargets.map((target) => deleteObserverAccount(target)),
      );
      const remoteFailure = remoteResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (remoteFailure) {
        throw managedAccountRemoteDeleteError(remoteFailure.reason);
      }

      const [deleted] = await transaction<Array<{ id: string }>>`
        update managed_accounts
        set deleted_at = now(),
            revision = revision + 1,
            updated_at = now()
        where id = ${input.id}
          and owner_user_id = ${input.ownerUserId}
          and revision = ${input.expectedRevision}
          and deleted_at is null
        returning id
      `;
      if (!deleted) {
        throw new ManagedAccountServiceError(
          "ACCOUNT_REVISION_CONFLICT",
          "Account changed in another session or no longer exists",
        );
      }
      await transaction`
        delete from remote_account_catalog catalog
        using sub2api_account_links link
        where link.managed_account_id = ${input.id}
          and link.owner_user_id = ${input.ownerUserId}
          and catalog.connection_id = link.connection_id
          and catalog.external_account_id = link.external_account_id
      `;
      await transaction`
        delete from sub2api_account_links
        where managed_account_id = ${input.id}
          and owner_user_id = ${input.ownerUserId}
      `;
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'managed_account.deleted',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({
            accountId: input.id,
            remoteAccountsDeleted: remoteAccounts.length,
          })}
        )
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export type BatchDeleteResult = {
  results: Array<{
    id: string;
    status: "success" | "failed";
    code?: string;
    message?: string;
  }>;
  succeeded: number;
  failed: number;
};

export type BatchUpdateResult = {
  results: Array<{
    id: string;
    status: "success" | "failed";
    code?: string;
    message?: string;
  }>;
  succeeded: number;
  failed: number;
};

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) break;
        try {
          const value = await fn(items[current]!);
          results[current] = { status: "fulfilled", value };
        } catch (reason) {
          results[current] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function batchDeleteManagedAccounts(input: {
  ownerUserId: string;
  deletes: Array<{ id: string; expectedRevision: number }>;
  requestId?: string;
}): Promise<BatchDeleteResult> {
  if (!input.deletes.length) {
    return { results: [], succeeded: 0, failed: 0 };
  }
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const ids = input.deletes.map((item) => item.id);
    const existingRows = ids.length
      ? await sql<Array<{ id: string; revision: number }>>`
          select id, revision from managed_accounts
          where owner_user_id = ${input.ownerUserId}
            and id in ${sql(ids)}
            and deleted_at is null
        `
      : [];
    const existingMap = new Map(existingRows.map((row) => [row.id, row.revision]));
    const results: BatchDeleteResult["results"] = [];
    const preliminarySucceeded: Array<{ id: string; expectedRevision: number }> = [];
    for (const item of input.deletes) {
      const current = existingMap.get(item.id);
      if (current === undefined) {
        results.push({
          id: item.id,
          status: "failed",
          code: "ACCOUNT_NOT_FOUND",
          message: "Account not found or already deleted",
        });
      } else if (current !== item.expectedRevision) {
        results.push({
          id: item.id,
          status: "failed",
          code: "ACCOUNT_REVISION_CONFLICT",
          message: "Account changed in another session or no longer exists",
        });
      } else {
        preliminarySucceeded.push(item);
      }
    }
    if (!preliminarySucceeded.length) {
      return {
        results: input.deletes.map((item) => results.find((entry) => entry.id === item.id)!),
        succeeded: 0,
        failed: results.length,
      };
    }

    const succIds = preliminarySucceeded.map((item) => item.id);
    const linkRows = succIds.length
      ? await sql<Array<{
          managedAccountId: string;
          connectionId: string;
          baseUrl: string;
          externalAccountId: string;
          tokenCiphertext: ServiceCiphertext;
        }>>`
          select
            link.managed_account_id as "managedAccountId",
            conn.id as "connectionId",
            conn.base_url as "baseUrl",
            link.external_account_id as "externalAccountId",
            conn.token_ciphertext as "tokenCiphertext"
          from sub2api_account_links link
          join sub2api_connections conn
            on conn.id = link.connection_id
            and conn.owner_user_id = ${input.ownerUserId}
          where link.managed_account_id in ${sql(succIds)}
            and link.owner_user_id = ${input.ownerUserId}
          order by link.managed_account_id, conn.id
        `
      : [];

    const connectionIds = [...new Set(linkRows.map((row) => row.connectionId))];
    const tokenByConnection = new Map<string, string>();
    const decryptFailConnections = new Set<string>();
    for (const connectionId of connectionIds) {
      const sample = linkRows.find((row) => row.connectionId === connectionId)!;
      try {
        const token = await decryptServiceToken({
          connectionId,
          ownerUserId: input.ownerUserId,
          envelope: serviceCiphertextSchema.parse(sample.tokenCiphertext),
          config,
        });
        tokenByConnection.set(connectionId, token);
      } catch {
        decryptFailConnections.add(connectionId);
      }
    }

    const targetsByAccount = new Map<
      string,
      Array<{ baseUrl: string; token: string; accountId: string; connectionId: string }>
    >();
    const decryptFailAccounts = new Set<string>();
    for (const row of linkRows) {
      const token = tokenByConnection.get(row.connectionId);
      if (!token) {
        decryptFailAccounts.add(row.managedAccountId);
        continue;
      }
      const list = targetsByAccount.get(row.managedAccountId) ?? [];
      list.push({
        baseUrl: row.baseUrl,
        token,
        accountId: row.externalAccountId,
        connectionId: row.connectionId,
      });
      targetsByAccount.set(row.managedAccountId, list);
    }
    for (const accountId of decryptFailAccounts) {
      results.push({
        id: accountId,
        status: "failed",
        code: "SUB2API_DELETE_CREDENTIAL_UNAVAILABLE",
        message: "Sub2API deletion credential is unavailable",
      });
    }

    const afterDecryptSucceeded = preliminarySucceeded.filter(
      (item) => !decryptFailAccounts.has(item.id),
    );

    const remoteTargets: Array<{
      managedAccountId: string;
      baseUrl: string;
      token: string;
      accountId: string;
    }> = [];
    for (const item of afterDecryptSucceeded) {
      const targets = targetsByAccount.get(item.id) ?? [];
      for (const target of targets) {
        remoteTargets.push({
          managedAccountId: item.id,
          baseUrl: target.baseUrl,
          token: target.token,
          accountId: target.accountId,
        });
      }
    }

    const remoteFailByAccount = new Map<string, unknown>();
    if (remoteTargets.length) {
      const settled = await runWithConcurrency(remoteTargets, 10, (target) =>
        deleteObserverAccount({
          baseUrl: target.baseUrl,
          token: target.token,
          accountId: target.accountId,
        }),
      );
      for (let index = 0; index < remoteTargets.length; index += 1) {
        const target = remoteTargets[index]!;
        const outcome = settled[index]!;
        if (outcome.status === "rejected" && !remoteFailByAccount.has(target.managedAccountId)) {
          remoteFailByAccount.set(target.managedAccountId, outcome.reason);
        }
      }
    }

    for (const [accountId, reason] of remoteFailByAccount) {
      const mapped = managedAccountRemoteDeleteError(reason);
      results.push({
        id: accountId,
        status: "failed",
        code: mapped.code,
        message: mapped.message,
      });
    }

    const toLocalDelete = afterDecryptSucceeded.filter((item) => !remoteFailByAccount.has(item.id));
    if (!toLocalDelete.length) {
      const ordered = input.deletes.map((item) => results.find((entry) => entry.id === item.id)!);
      return {
        results: ordered,
        succeeded: ordered.filter((entry) => entry.status === "success").length,
        failed: ordered.filter((entry) => entry.status === "failed").length,
      };
    }

    const actuallyDeleted: string[] = [];
    const txFailedIds = new Set<string>();
    await sql.begin(async (tx) => {
      for (const item of toLocalDelete) {
        const [deleted] = await tx<Array<{ id: string }>>`
          update managed_accounts
          set deleted_at = now(), revision = revision + 1, updated_at = now()
          where id = ${item.id}
            and owner_user_id = ${input.ownerUserId}
            and revision = ${item.expectedRevision}
            and deleted_at is null
          returning id
        `;
        if (!deleted) txFailedIds.add(item.id);
        else actuallyDeleted.push(item.id);
      }
      if (actuallyDeleted.length) {
        await tx`
          delete from remote_account_catalog catalog
          using sub2api_account_links link
          where link.managed_account_id in ${tx(actuallyDeleted)}
            and link.owner_user_id = ${input.ownerUserId}
            and catalog.connection_id = link.connection_id
            and catalog.external_account_id = link.external_account_id
        `;
        await tx`
          delete from sub2api_account_links
          where managed_account_id in ${tx(actuallyDeleted)}
            and owner_user_id = ${input.ownerUserId}
        `;
        await tx`
          insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
          values (${randomUUID()}, ${input.ownerUserId}, 'managed_account.batch_deleted', 'success', ${input.requestId ?? null}, ${tx.json({ count: actuallyDeleted.length, accountIds: actuallyDeleted })})
        `;
      }
    });

    for (const accountId of txFailedIds) {
      results.push({
        id: accountId,
        status: "failed",
        code: "ACCOUNT_REVISION_CONFLICT",
        message: "Account changed in another session or no longer exists",
      });
    }
    for (const accountId of actuallyDeleted) {
      results.push({ id: accountId, status: "success" });
    }

    const ordered = input.deletes.map((item) => results.find((entry) => entry.id === item.id)!);
    return {
      results: ordered,
      succeeded: ordered.filter((entry) => entry.status === "success").length,
      failed: ordered.filter((entry) => entry.status === "failed").length,
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function batchUpdateManagedAccounts(input: {
  ownerUserId: string;
  updates: Array<{ id: string; expectedRevision: number }>;
  localStatus: AccountLocalStatus;
  requestId?: string;
}): Promise<BatchUpdateResult> {
  if (!input.updates.length) {
    return { results: [], succeeded: 0, failed: 0 };
  }
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const ids = input.updates.map((item) => item.id);
    const existingRows = ids.length
      ? await sql<Array<{ id: string; revision: number }>>`
          select id, revision from managed_accounts
          where owner_user_id = ${input.ownerUserId}
            and id in ${sql(ids)}
            and deleted_at is null
        `
      : [];
    const existingMap = new Map(existingRows.map((row) => [row.id, row.revision]));
    const results: BatchUpdateResult["results"] = [];
    const preliminarySucceeded: Array<{ id: string; expectedRevision: number }> = [];
    for (const item of input.updates) {
      const current = existingMap.get(item.id);
      if (current === undefined) {
        results.push({
          id: item.id,
          status: "failed",
          code: "ACCOUNT_NOT_FOUND",
          message: "Account not found or already deleted",
        });
      } else if (current !== item.expectedRevision) {
        results.push({
          id: item.id,
          status: "failed",
          code: "ACCOUNT_REVISION_CONFLICT",
          message: "Account changed in another session or no longer exists",
        });
      } else {
        preliminarySucceeded.push(item);
      }
    }
    if (!preliminarySucceeded.length) {
      return {
        results: input.updates.map((item) => results.find((entry) => entry.id === item.id)!),
        succeeded: 0,
        failed: results.length,
      };
    }

    const actuallyUpdated: string[] = [];
    const txFailedIds = new Set<string>();
    await sql.begin(async (tx) => {
      for (const item of preliminarySucceeded) {
        const [updated] = await tx<Array<{ id: string }>>`
          update managed_accounts
          set local_status = ${input.localStatus}, revision = revision + 1, updated_at = now()
          where id = ${item.id}
            and owner_user_id = ${input.ownerUserId}
            and revision = ${item.expectedRevision}
            and deleted_at is null
          returning id
        `;
        if (!updated) txFailedIds.add(item.id);
        else actuallyUpdated.push(item.id);
      }
      if (actuallyUpdated.length) {
        await tx`
          insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
          values (${randomUUID()}, ${input.ownerUserId}, 'managed_account.batch_updated', 'success', ${input.requestId ?? null}, ${tx.json({ count: actuallyUpdated.length, accountIds: actuallyUpdated, localStatus: input.localStatus })})
        `;
      }
    });

    for (const accountId of txFailedIds) {
      results.push({
        id: accountId,
        status: "failed",
        code: "ACCOUNT_REVISION_CONFLICT",
        message: "Account changed in another session or no longer exists",
      });
    }
    for (const accountId of actuallyUpdated) {
      results.push({ id: accountId, status: "success" });
    }
    const ordered = input.updates.map((item) => results.find((entry) => entry.id === item.id)!);
    return {
      results: ordered,
      succeeded: ordered.filter((entry) => entry.status === "success").length,
      failed: ordered.filter((entry) => entry.status === "failed").length,
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

function managedAccountRemoteDeleteError(error: unknown): ManagedAccountServiceError {
  if (!(error instanceof Sub2apiClientError)) {
    return new ManagedAccountServiceError(
      "SUB2API_DELETE_FAILED",
      "Sub2API account deletion failed",
      502,
    );
  }
  if (error.code === "OBSERVER_DELETE_FORBIDDEN") {
    return new ManagedAccountServiceError(
      error.code,
      "Sub2API integration token does not have account deletion permission",
      424,
    );
  }
  if (error.code === "OBSERVER_AUTH_REJECTED") {
    return new ManagedAccountServiceError(
      error.code,
      "Sub2API rejected the integration token",
      424,
    );
  }
  return new ManagedAccountServiceError(
    error.code,
    error.retryable
      ? "Sub2API account deletion is temporarily unavailable"
      : "Sub2API account deletion failed",
    error.retryable ? 503 : 424,
  );
}
