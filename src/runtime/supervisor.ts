import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let releaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let webRoot = path.join(releaseRoot, ".next", "standalone");
let webEntry = path.join(webRoot, "server.js");
let workerEntry = path.join(releaseRoot, "dist", "worker", "index.mjs");
const graceSeconds = Number(process.env.SHUTDOWN_GRACE_SECONDS ?? "30");
const allowUnprivileged = process.env.ACCOUNT_VAULT_ALLOW_UNPRIVILEGED === "true";
let releaseId = process.env.ACCOUNT_VAULT_RELEASE_ID ?? "unknown";
let stopping = false;
let exitCode = 0;
let forceTimer: NodeJS.Timeout | undefined;

function log(level: "info" | "error", event: string, fields: Record<string, unknown> = {}) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    component: "supervisor",
    releaseId,
    event,
    ...fields,
  };
  process[level === "error" ? "stderr" : "stdout"].write(`${JSON.stringify(line)}\n`);
}

type ReleaseManifest = {
  manifestVersion: number;
  releaseId: string;
  targetNodeVersion: string;
  nodeAbi: string;
  files: Record<string, string>;
  links: Record<string, string>;
};

function isWithinRelease(candidate: string): boolean {
  return candidate.startsWith(`${releaseRoot}${path.sep}`);
}

async function verifyRelease(): Promise<void> {
  releaseRoot = await realpath(releaseRoot);
  webRoot = path.join(releaseRoot, ".next", "standalone");
  webEntry = path.join(webRoot, "server.js");
  workerEntry = path.join(releaseRoot, "dist", "worker", "index.mjs");
  await Promise.all([
    access(webEntry, constants.R_OK),
    access(workerEntry, constants.R_OK),
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(releaseRoot, "release-manifest.json"), "utf8"),
  ) as ReleaseManifest;
  if (
    manifest.manifestVersion !== 1 ||
    !manifest.releaseId ||
    !manifest.files ||
    !manifest.links
  ) {
    throw new Error("Release manifest is invalid");
  }
  if (!allowUnprivileged && process.versions.node !== manifest.targetNodeVersion) {
    throw new Error(
      `Node version mismatch: expected ${manifest.targetNodeVersion}, got ${process.versions.node}`,
    );
  }
  if (!allowUnprivileged && process.versions.modules !== manifest.nodeAbi) {
    throw new Error("Node ABI does not match the release manifest");
  }
  for (const [relativePath, expectedTarget] of Object.entries(manifest.links)) {
    const candidate = path.resolve(releaseRoot, relativePath);
    if (!isWithinRelease(candidate)) {
      throw new Error("Release manifest contains an unsafe link path");
    }
    const actualTarget = (await readlink(candidate)).replaceAll("\\", "/");
    if (actualTarget !== expectedTarget) {
      throw new Error(`Release symlink mismatch: ${relativePath}`);
    }
    if (!isWithinRelease(await realpath(candidate))) {
      throw new Error(`Release symlink escapes release root: ${relativePath}`);
    }
  }
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const candidate = path.resolve(releaseRoot, relativePath);
    if (!isWithinRelease(candidate) || (await lstat(candidate)).isSymbolicLink()) {
      throw new Error("Release manifest contains an unsafe file path");
    }
    const actualHash = createHash("sha256")
      .update(await readFile(candidate))
      .digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Release file hash mismatch: ${relativePath}`);
    }
  }
  if (process.platform !== "linux" && !allowUnprivileged) {
    throw new Error("Production supervisor requires Linux");
  }
  if (process.platform === "linux" && process.getuid?.() !== 0 && !allowUnprivileged) {
    throw new Error("Supervisor must start as root so child processes can be deprivileged");
  }
  releaseId = manifest.releaseId;
  process.env.ACCOUNT_VAULT_RELEASE_ID = releaseId;
  log("info", "release_verified", { releaseRoot });
}

function childIdentity(component: "web" | "worker") {
  if (allowUnprivileged || process.platform !== "linux") return {};
  return component === "web"
    ? { uid: 10001, gid: 10001 }
    : { uid: 10002, gid: 10001 };
}

function startChild(component: "web" | "worker", entry: string, cwd: string): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ACCOUNT_VAULT_RELEASE_ROOT: releaseRoot,
      LOG_COMPONENT: component,
    },
    stdio: "inherit",
    ...childIdentity(component),
  });
  log("info", "child_started", { component, pid: child.pid });
  return child;
}

let web: ChildProcess;
let worker: ChildProcess;

function stop(signal: NodeJS.Signals, code = exitCode) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  log("info", "shutdown_started", { signal, exitCode });
  worker?.kill(signal);
  setTimeout(() => web?.kill(signal), 250).unref();
  forceTimer = setTimeout(() => {
    log("error", "shutdown_timeout", { graceSeconds });
    worker?.kill("SIGKILL");
    web?.kill("SIGKILL");
    process.exit(exitCode || 1);
  }, Math.max(1, graceSeconds) * 1000);
  forceTimer.unref();
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function maybeExit() {
  if (!stopping || !childHasExited(web) || !childHasExited(worker)) return;
  if (forceTimer) clearTimeout(forceTimer);
  log("info", "shutdown_complete", { exitCode });
  process.exit(exitCode);
}

async function main() {
  await verifyRelease();
  web = startChild("web", webEntry, webRoot);
  worker = startChild("worker", workerEntry, releaseRoot);

  for (const [component, child] of [
    ["web", web],
    ["worker", worker],
  ] as const) {
    child.on("error", (error) => {
      log("error", "child_spawn_failed", { component, message: error.message });
      stop("SIGTERM", 1);
    });
    child.on("exit", (code, signal) => {
      log(code === 0 && stopping ? "info" : "error", "child_exited", {
        component,
        code,
        signal,
      });
      if (!stopping) stop("SIGTERM", code && code > 0 ? code : 1);
      maybeExit();
    });
  }

  process.on("SIGTERM", () => stop("SIGTERM", 0));
  process.on("SIGINT", () => stop("SIGINT", 0));
}

main().catch((error) => {
  log("error", "startup_failed", {
    message: error instanceof Error ? error.message : "unknown startup failure",
  });
  process.exit(1);
});
