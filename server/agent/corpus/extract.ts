import { createHash } from "node:crypto";
import type { CorpusConfig } from "./config.ts";
import type { ScriptFile, ScriptType, GameMeta } from "./types.ts";
import { getR2Object } from "./cloudflare.ts";

export function inferScriptType(filePath: string): ScriptType {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".server.lua") || lower.endsWith(".server.luau")) return "server";
  if (lower.endsWith(".client.lua") || lower.endsWith(".client.luau")) return "client";
  if (/localscript/i.test(lower)) return "client";
  if (/modulescript/i.test(lower)) return "module";
  if (lower.endsWith(".lua") || lower.endsWith(".luau")) return "module";
  return "unknown";
}

export function filePathToRobloxPath(filePath: string): string {
  const rel = filePath.replace(/^raw\//, "");
  const noExt = rel
    .replace(/\.(server|client)\.(lua|luau)$/, "")
    .replace(/\.(lua|luau)$/, "");
  return `game.${noExt.replace(/\//g, ".")}`;
}

const SERVICE_RX = /game:GetService\(["'](\w+)["']\)|game\.(\w{3,}(?:Service|Storage|Gui|Player))\b/g;
const REMOTE_RX = /(?:FireServer|FireClient|FireAllClients|OnServerEvent|OnClientEvent|InvokeServer|OnServerInvoke|RemoteEvent|RemoteFunction)\b/g;
const REQUIRE_RX = /require\s*\(\s*(game[\w.]+|script(?:\.Parent)?\.\w+)\s*\)/g;
const FUNC_RX = /(?:^|\n)\s*(?:local\s+)?function\s+([\w.]+)\s*\(/gm;
const METHOD_RX = /(?:^|\n)\s*([\w]+)\s*=\s*function\b/gm;

export function parseScriptMetadata(source: string, filePath: string): Omit<ScriptFile, "filePath" | "robloxPath"> {
  const services: string[] = [];
  const remotes = new Set<string>();
  const symbols: string[] = [];
  const requiredModules: string[] = [];

  let m: RegExpExecArray | null;

  const svcRx = new RegExp(SERVICE_RX.source, "g");
  while ((m = svcRx.exec(source)) !== null) {
    const svc = m[1] ?? m[2];
    if (svc && !services.includes(svc)) services.push(svc);
  }

  const remoteRx = new RegExp(REMOTE_RX.source, "g");
  while ((m = remoteRx.exec(source)) !== null) remotes.add(m[0]);

  const reqRx = new RegExp(REQUIRE_RX.source, "g");
  while ((m = reqRx.exec(source)) !== null) {
    if (!requiredModules.includes(m[1])) requiredModules.push(m[1]);
  }

  const funcRx = new RegExp(FUNC_RX.source, "gm");
  while ((m = funcRx.exec(source)) !== null) {
    if (!symbols.includes(m[1])) symbols.push(m[1]);
  }
  const methodRx = new RegExp(METHOD_RX.source, "gm");
  while ((m = methodRx.exec(source)) !== null) {
    if (!symbols.includes(m[1])) symbols.push(m[1]);
  }

  return {
    source,
    scriptType: inferScriptType(filePath),
    symbols: symbols.slice(0, 40),
    services,
    remotes: [...remotes],
    requiredModules: requiredModules.slice(0, 20),
    lineCount: source.split("\n").length,
    sourceHash: createHash("sha256").update(source).digest("hex").slice(0, 16),
  };
}

export async function extractGameFiles(
  r2Prefix: string,
  manifest: string[],
  _meta: GameMeta,
  config: CorpusConfig,
): Promise<ScriptFile[]> {
  const files: ScriptFile[] = [];
  for (const filePath of manifest) {
    const key = `${r2Prefix}${filePath}`;
    const source = await getR2Object(key, config);
    if (!source) {
      console.warn(`[corpus:extract] missing: ${key}`);
      continue;
    }
    const parsed = parseScriptMetadata(source, filePath);
    files.push({ filePath, robloxPath: filePathToRobloxPath(filePath), ...parsed });
  }
  return files;
}
