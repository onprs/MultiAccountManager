import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

async function main() {
  const root = process.cwd();
  const outputDirectory = path.join(root, "public", "_workers");

  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src", "crypto", "vault.worker.ts")],
    outfile: path.join(outputDirectory, "vault.worker.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["es2022"],
    minify: true,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    logLevel: "info",
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
