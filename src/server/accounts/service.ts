import { randomUUID } from "node:crypto";
import {
  managedAccountSchema,
  type AccountLocalStatus,
  type AccountPlatform,
  type ManagedAccount,
} from "@/accounts/schema";
import type { EncryptedEnvelope } from "@/crypto/schema";
import { readRuntimeConfig } from "@/runtime/config-store";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "@/server/database/connection";

export class ManagedAccountServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManagedAccountServiceError";
    this.code = code;
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
  emailBlindIndex?: string;
  emailDomainBlindIndex?: string;
}): Promise<ManagedAccountList> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  const search = input.search ? `%${escapeLike(input.search.trim())}%` : null;
  const platform = input.platform ?? null;
  const localStatus = input.localStatus ?? "active";
  const hasTotp = input.hasTotp ?? null;
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
          and deleted_at is null
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
          and deleted_at is null
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
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'managed_account.deleted',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.id })}
        )
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}
