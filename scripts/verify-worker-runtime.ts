import { spawn } from "node:child_process";
import path from "node:path";
import { readRuntimeConfig } from "../src/runtime/config-store";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "../src/server/database/connection";

const waitTimeoutMilliseconds = 45_000;

async function main() {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist/worker/index.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ACCOUNT_VAULT_RELEASE_ID: "worker-runtime-smoke",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = appendOutput(output, chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = appendOutput(output, chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  try {
    await waitFor(async () => {
      const [heartbeat] = await sql<Array<{ status: string; processId: number }>>`
        select status, process_id as "processId"
        from worker_heartbeats where component = 'sync-worker'
      `;
      return heartbeat?.status === "running" && heartbeat.processId === child.pid;
    });

    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      delay(waitTimeoutMilliseconds).then(() => null),
    ]);
    if (!exit) throw new Error("Worker did not stop within the graceful shutdown timeout");
    if (process.platform !== "win32" && exit.code !== 0) {
      throw new Error(`Worker exited unexpectedly with code ${exit.code} and signal ${exit.signal}`);
    }

    if (process.platform !== "win32") {
      await waitFor(async () => {
        const [heartbeat] = await sql<Array<{ status: string; processId: number }>>`
          select status, process_id as "processId"
          from worker_heartbeats where component = 'sync-worker'
        `;
        return heartbeat?.status === "stopped" && heartbeat.processId === child.pid;
      });
    }
    process.stdout.write(
      `${JSON.stringify({ workerRuntimeSmoke: "ok", processId: child.pid })}\n`,
    );
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    const message = error instanceof Error ? error.message : "Worker runtime smoke failed";
    throw new Error(`${message}; workerOutput=${sanitizeOutput(output)}`);
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + waitTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error("Worker heartbeat did not reach the expected state");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendOutput(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-20_000);
}

function sanitizeOutput(output: string): string {
  return output
    .replace(/s2obs_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .slice(-2_000);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
