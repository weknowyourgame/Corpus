import { spawnSync } from "node:child_process";
import { loadCorpusConfig, type CorpusConfig } from "./config.ts";

export type SetupCommand = {
  label: string;
  command: string;
  args: string[];
};

const KNOWN_NICHES = [
  "tower-defense",
  "fps",
  "obby",
  "rpg",
  "simulator",
  "tycoon",
  "battle-royale",
  "horror",
  "racing",
  "social",
  "general",
];

export function buildCloudflareSetupCommands(config: CorpusConfig): SetupCommand[] {
  const prefix = config.cloudflare.nicheIndexPrefix;
  const commands: SetupCommand[] = [
    {
      label: "Create R2 bucket",
      command: "wrangler",
      args: ["r2", "bucket", "create", config.cloudflare.r2Bucket],
    },
  ];
  for (const niche of KNOWN_NICHES) {
    commands.push({
      label: `Create Vectorize index for niche: ${niche}`,
      command: "wrangler",
      args: ["vectorize", "create", `${prefix}-${niche}`, "--dimensions=768", "--metric=cosine"],
    });
  }
  return commands;
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
    console.log("Cloudflare corpus setup commands (run with --execute to apply):\n");
    for (const command of commands) {
      console.log(`# ${command.label}`);
      console.log(formatCommand(command));
      console.log();
    }
    return;
  }

  runCommands(commands);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
