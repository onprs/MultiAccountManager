import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

async function copyIfPresent(source: string, destination: string) {
  try {
    await stat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

type Tree = { files: string[]; links: Array<{ path: string; target: string }> };

async function scanTree(directory: string): Promise<Tree> {
  const result: Tree = { files: [], links: [] };
  const entries = await readdir(directory);
  for (const name of entries) {
    const current = path.join(directory, name);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      result.links.push({ path: current, target: await readlink(current) });
    } else if (info.isDirectory()) {
      const nested = await scanTree(current);
      result.files.push(...nested.files);
      result.links.push(...nested.links);
    } else if (info.isFile()) {
      result.files.push(current);
    }
  }
  return result;
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function makeStandaloneLinksPortable(): Promise<void> {
  const tree = await scanTree(standalone);
  const sourceModules = await realpath(path.join(root, "node_modules"));
  const standaloneModules = path.join(standalone, "node_modules");

  const linksByDepth = tree.links.sort(
    (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
  );
  for (const link of linksByDepth) {
    const resolvedTarget = await realpath(link.path);
    if (isWithin(standalone, resolvedTarget)) continue;
    if (!isWithin(sourceModules, resolvedTarget)) {
      throw new Error(`Standalone symlink escapes node_modules: ${link.path}`);
    }

    const mappedTarget = path.join(
      standaloneModules,
      path.relative(sourceModules, resolvedTarget),
    );
    const sourceInfo = await stat(resolvedTarget);
    await mkdir(path.dirname(mappedTarget), { recursive: true });
    await cp(resolvedTarget, mappedTarget, {
      recursive: sourceInfo.isDirectory(),
      dereference: true,
      force: true,
    });
    const mappedInfo = await stat(mappedTarget);
    const portableTarget = path
      .relative(path.dirname(link.path), mappedTarget)
      .replaceAll("\\", "/");
    await unlink(link.path);
    if (process.platform === "win32") {
      await cp(mappedTarget, link.path, {
        recursive: mappedInfo.isDirectory(),
        dereference: true,
        force: true,
      });
    } else {
      await symlink(
        portableTarget,
        link.path,
        mappedInfo.isDirectory() ? "dir" : "file",
      );
    }
  }

  if (process.platform === "win32") {
    const hoistedModules = path.join(standaloneModules, ".pnpm", "node_modules");
    for (const name of await readdir(hoistedModules)) {
      const source = path.join(hoistedModules, name);
      const sourceInfo = await stat(source);
      await cp(source, path.join(standaloneModules, name), {
        recursive: sourceInfo.isDirectory(),
        dereference: true,
        force: true,
      });
    }
  }

  const portableTree = await scanTree(standalone);
  for (const link of portableTree.links) {
    const resolvedTarget = await realpath(link.path);
    if (!isWithin(standalone, resolvedTarget)) {
      throw new Error(`Standalone symlink remains external: ${link.path}`);
    }
  }
}

function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "uncommitted";
  }
}

function relativeName(file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

async function main() {
  await copyIfPresent(
    path.join(root, ".next", "static"),
    path.join(standalone, ".next", "static"),
  );
  await copyIfPresent(path.join(root, "public"), path.join(standalone, "public"));
  await makeStandaloneLinksPortable();

  const requiredRoots = [
    standalone,
    path.join(root, "dist"),
    path.join(root, "db", "migrations"),
  ];
  const trees = await Promise.all(requiredRoots.map(scanTree));
  const files = trees.flatMap((tree) => tree.files).sort();
  const links = trees.flatMap((tree) => tree.links);
  const hashes: Record<string, string> = {};
  const linkTargets: Record<string, string> = {};

  for (const file of files) {
    hashes[relativeName(file)] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
  for (const link of links) {
    linkTargets[relativeName(link.path)] = link.target.replaceAll("\\", "/");
  }

  const sha = gitSha();
  const manifest = {
    manifestVersion: 1,
    releaseId: process.env.ACCOUNT_VAULT_RELEASE_ID ?? sha.slice(0, 12),
    gitSha: sha,
    createdAt: new Date().toISOString(),
    targetNodeVersion: "22.22.2",
    buildNodeVersion: process.versions.node,
    nodeAbi: process.versions.modules,
    schemaVersion: 6,
    configVersion: 1,
    cryptoVersion: 1,
    files: hashes,
    links: linkTargets,
  };
  await writeFile(
    path.join(root, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
