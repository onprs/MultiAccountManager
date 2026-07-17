import { readRuntimeConfig } from "@/runtime/config-store";
import { getRuntimeStatus } from "@/runtime/status";
import { startJobRuntime } from "@/server/jobs/runtime";

const pollMilliseconds = Number(process.env.WORKER_SETUP_POLL_MS ?? "30000");
let stopping = false;
let wakeForShutdown: (() => void) | undefined;

function log(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  process[level === "error" ? "stderr" : "stdout"].write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: "worker",
      releaseId: process.env.ACCOUNT_VAULT_RELEASE_ID ?? "development",
      event,
      ...fields,
    })}\n`,
  );
}

async function sleep(milliseconds: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    wakeForShutdown = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  wakeForShutdown = undefined;
}

async function main() {
  const requestShutdown = () => {
    stopping = true;
    wakeForShutdown?.();
  };
  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);

  let previousState: string | undefined;
  let runtime: Awaited<ReturnType<typeof startJobRuntime>> | undefined;
  while (!stopping && !runtime) {
    const status = await getRuntimeStatus();
    if (status.state !== previousState) {
      log("info", status.state === "ready" ? "runtime_ready" : "waiting_for_setup", {
        setupState: status.state,
      });
      previousState = status.state;
    }
    if (status.state === "ready") {
      const config = await readRuntimeConfig();
      runtime = await startJobRuntime(config, log);
      break;
    }
    await sleep(Math.max(1000, pollMilliseconds));
  }

  while (!stopping) await sleep(Math.max(1000, pollMilliseconds));
  if (runtime) await runtime.stop();
  log("info", "shutdown_complete");
}

main().catch((error) => {
  log("error", "fatal_error", {
    message: error instanceof Error ? error.message : "unknown worker failure",
  });
  process.exit(1);
});
