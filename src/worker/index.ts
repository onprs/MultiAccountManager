import { getRuntimeStatus } from "@/runtime/status";

const pollMilliseconds = Number(process.env.WORKER_SETUP_POLL_MS ?? "30000");
let stopping = false;
let wakeForShutdown: (() => void) | undefined;

function log(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
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
  while (!stopping) {
    const runtime = await getRuntimeStatus();
    if (runtime.state !== previousState) {
      log(runtime.state === "ready" ? "runtime_ready" : "waiting_for_setup", {
        setupState: runtime.state,
      });
      previousState = runtime.state;
    }
    if (runtime.state === "ready") {
      // pg-boss startup is added with the first durable job implementation.
    }
    await sleep(Math.max(1000, pollMilliseconds));
  }
  log("shutdown_complete");
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      component: "worker",
      event: "fatal_error",
      message: error instanceof Error ? error.message : "unknown worker failure",
    })}\n`,
  );
  process.exit(1);
});
