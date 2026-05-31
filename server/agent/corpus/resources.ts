import { spawnSync } from "node:child_process";
import { loadCorpusConfig, type CorpusConfig } from "./config.ts";

export type SetupCommand = {
  label: string;
  command: string;
  args: string[];
};

export function buildCloudflareSetupCommands(config: CorpusConfig): SetupCommand[] {
  const indexes = config.cloudflare.vectorizeIndexes;
  return [
    {
      label: "Create R2 bucket",
      command: "wrangler",
      args: ["r2", "bucket", "create", config.cloudflare.r2Bucket],
    },
    {
      label: "Create game summary Vectorize index",
      command: "wrangler",
      args: ["vectorize", "create", indexes.gameSummaries, "--dimensions=768", "--metric=cosine"],
    },
    {
      label: "Create systems Vectorize index",
      command: "wrangler",
      args: ["vectorize", "create", indexes.systems, "--dimensions=768", "--metric=cosine"],
    },
    {
      label: "Create scripts Vectorize index",
      command: "wrangler",
      args: ["vectorize", "create", indexes.scripts, "--dimensions=768", "--metric=cosine"],
    },
    {
      label: "Create patterns Vectorize index",
      command: "wrangler",
      args: ["vectorize", "create", indexes.patterns, "--dimensions=768", "--metric=cosine"],
    },
  ];
}

export function formatCommand(command: SetupCommand): string {
  return [command.command, ...command.args].map((part) =>
    /\s/.test(part) ? JSON.stringify(part) : part,
  ).join(" ");
}

export function runCommands(commands: SetupCommand[]): void {
  for (const command of commands) {
    console.log(`\n[corpus:cloudflare:setup] ${command.label}`);
    console.log(formatCommand(command));
    const result = spawnSync(command.command, command.args, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`${command.label} failed with exit code ${result.status ?? "unknown"}`);
    }
  }
}

function main() {
  const execute = process.argv.includes("--execute");
  const config = loadCorpusConfig();
  const commands = buildCloudflareSetupCommands(config);

  if (!execute) {
    console.log("Cloudflare corpus setup commands:");
    console.log("Run with --execute to execute them through wrangler.\n");
    for (const command of commands) {
      console.log(`# ${command.label}`);
      console.log(formatCommand(command));
    }
    return;
  }

  runCommands(commands);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
