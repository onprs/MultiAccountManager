import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";
import { encryptServiceToken } from "@/server/integrations/service-cipher";
import { enqueueManualConnectionSync } from "@/server/jobs/runtime";
import {
  normalizeSub2apiBaseUrl,
  testSub2apiConnection,
} from "@/server/sub2api/client";

type ExistingConnection = {
  id: string;
  name: string;
  baseUrl: string;
  remoteInstanceId: string | null;
};

export type ProvisionSub2apiConnectionResult = {
  connectionProvisioned: true;
  connectionCreated: boolean;
  connectionId: string;
  instanceId: string;
  syncQueued: boolean;
};

export async function provisionSub2apiConnection(input: {
  baseUrl: string;
  name: string;
  token: string;
}): Promise<ProvisionSub2apiConnectionResult> {
  const baseUrl = normalizeSub2apiBaseUrl(input.baseUrl);
  const name = input.name.trim();
  const token = input.token.trim();
  if (!name || name.length > 100) throw new Error("Connection name is invalid");

  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  let connectionId = "";
  let connectionCreated = false;
  let instanceId = "";
  try {
    const owners = await sql<Array<{ id: string }>>`
      select id from users where role = 'owner' order by created_at asc limit 2
    `;
    if (owners.length !== 1 || !owners[0]) {
      throw new Error("Exactly one owner is required");
    }
    const ownerUserId = owners[0].id;
    const matches = await sql<Array<ExistingConnection>>`
      select id, name, base_url as "baseUrl", remote_instance_id as "remoteInstanceId"
      from sub2api_connections
      where owner_user_id = ${ownerUserId}
        and (name = ${name} or base_url = ${baseUrl})
      order by id
      limit 2
    `;
    if (matches.length > 1) {
      throw new Error("Connection name and Base URL resolve to different records");
    }
    const existing = matches[0];
    if (existing && (existing.name !== name || existing.baseUrl !== baseUrl)) {
      throw new Error("Existing connection name and Base URL must both match");
    }

    const test = await testSub2apiConnection({
      baseUrl,
      token,
      expectedInstanceId: existing?.remoteInstanceId,
    });
    instanceId = test.instanceId;
    connectionId = existing?.id ?? randomUUID();
    connectionCreated = !existing;
    const tokenCiphertext = await encryptServiceToken({
      connectionId,
      ownerUserId,
      token,
      config,
    });

    await sql.begin(async (transaction) => {
      if (existing) {
        const updated = await transaction`
          update sub2api_connections
          set token_ciphertext = ${transaction.json(tokenCiphertext)},
              token_key_id = ${tokenCiphertext.keyId},
              token_hint = ${tokenHint(token)},
              remote_instance_id = coalesce(remote_instance_id, ${test.instanceId}),
              consecutive_failures = 0,
              last_error_code = null,
              last_error_summary = null,
              updated_at = now()
          where id = ${connectionId}
            and owner_user_id = ${ownerUserId}
            and name = ${name}
            and base_url = ${baseUrl}
        `;
        if (updated.count !== 1) {
          throw new Error("Existing connection changed during token replacement");
        }
      } else {
        await transaction`
          insert into sub2api_connections (
            id, owner_user_id, name, base_url, remote_instance_id,
            token_ciphertext, token_key_id, token_hint, sync_interval_seconds
          ) values (
            ${connectionId}, ${ownerUserId}, ${name}, ${baseUrl}, ${test.instanceId},
            ${transaction.json(tokenCiphertext)}, ${tokenCiphertext.keyId},
            ${tokenHint(token)}, 300
          )
        `;
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, metadata
        ) values (
          ${randomUUID()},
          ${ownerUserId},
          ${existing
            ? "sub2api.connection.token_replaced"
            : "sub2api.connection.provisioned"},
          'success',
          ${transaction.json({
            connectionId,
            instanceId: test.instanceId,
            tokenReplaced: Boolean(existing),
          })}
        )
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }

  const syncJobId = await enqueueManualConnectionSync(connectionId).catch(() => null);
  return {
    connectionProvisioned: true,
    connectionCreated,
    connectionId,
    instanceId,
    syncQueued: Boolean(syncJobId),
  };
}

async function main() {
  const tokenFile = requiredEnvironment("SUB2API_OBSERVER_TOKEN_FILE");
  const tokenFileStat = await stat(tokenFile);
  if (!tokenFileStat.isFile() || (tokenFileStat.mode & 0o077) !== 0) {
    throw new Error("Observer token file must be a regular file with mode 0600 or stricter");
  }

  const tokenBuffer = await readFile(tokenFile);
  try {
    const result = await provisionSub2apiConnection({
      baseUrl: requiredEnvironment("SUB2API_BASE_URL"),
      name: process.env.SUB2API_CONNECTION_NAME ?? "sub2api_tokyo",
      token: tokenBuffer.toString("utf8"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    tokenBuffer.fill(0);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tokenHint(token: string): string {
  return `${token.slice(0, Math.min(6, token.length))}...${token.slice(-4)}`;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Provisioning failed"}\n`);
    process.exit(1);
  });
}
