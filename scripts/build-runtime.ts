import path from "node:path";
import { build } from "esbuild";

async function main() {
  const projectRoot = process.cwd();
  await build({
    entryPoints: [
      path.join(projectRoot, "src/runtime/supervisor.ts"),
      path.join(projectRoot, "src/runtime/upgrade.ts"),
      path.join(projectRoot, "src/worker/index.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outbase: path.join(projectRoot, "src"),
    outdir: path.join(projectRoot, "dist"),
    outExtension: { ".js": ".mjs" },
    banner: {
      js: [
        'import { createRequire as __accountVaultCreateRequire } from "node:module";',
        "const require = __accountVaultCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
