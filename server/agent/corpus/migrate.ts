import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpusConfig } from "./config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const schemaPath = join(__dirname, "schema.sql");

export function buildMigrationCommand(databaseUrl: string) {
  return {
    command: "psql",
    args: [databaseUrl, "--file", schemaPath, "--set", "ON_ERROR_STOP=1"],
  };
}

function main() {
  const config = loadCorpusConfig();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is required to run corpus migrations.");
    process.exitCode = 1;
    return;
  }

  const migration = buildMigrationCommand(config.databaseUrl);
  console.log(`[corpus:migrate] Applying ${schemaPath}`);
  const result = spawnSync(migration.command, migration.args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
