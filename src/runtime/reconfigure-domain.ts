import { prepareDomainMigration } from "./domain-migration";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main() {
  const publicUrl = option("--public-url");
  if (!publicUrl) {
    throw new Error("Expected --public-url <https-origin> [--rp-id <domain>]");
  }
  const result = await prepareDomainMigration({
    publicUrl,
    rpId: option("--rp-id"),
  });
  process.stdout.write(
    `${JSON.stringify({ domainMigration: "prepared", ...result })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      domainMigration: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`,
  );
  process.exit(1);
});
