import { randomUUID } from "node:crypto";
import type { ScriptFile, RawChunk, ChunkType, ScriptType, GameMeta } from "./types.ts";

const MAX_SCRIPT_CHARS = 6000;

const nicheIndex = (prefix: string, niche: string) => `${prefix}-${niche}`;

function buildEmbedText(meta: GameMeta, extra: {
  systemName?: string;
  robloxPath?: string;
  scriptType?: ScriptType;
  services?: string[];
  symbols?: string[];
}, snippet: string): string {
  return [
    `game: ${meta.name}`,
    `niche: ${meta.niche}`,
    extra.systemName ? `system: ${extra.systemName}` : "",
    extra.robloxPath ? `path: ${extra.robloxPath}` : "",
    extra.scriptType ? `run_side: ${extra.scriptType}` : "",
    extra.services?.length ? `services: ${extra.services.join(", ")}` : "",
    extra.symbols?.length ? `symbols: ${extra.symbols.slice(0, 10).join(", ")}` : "",
    snippet.slice(0, 800),
  ].filter(Boolean).join("\n");
}

export function buildGameSummaryChunk(meta: GameMeta, files: ScriptFile[], indexPrefix: string): RawChunk {
  const id = randomUUID();
  const allServices = [...new Set(files.flatMap((f) => f.services))];
  const allRemotes = [...new Set(files.flatMap((f) => f.remotes))];

  const content = [
    `# ${meta.name}`,
    `niche: ${meta.niche}`,
    meta.subniches?.length ? `subniches: ${meta.subniches.join(", ")}` : "",
    meta.mechanics?.length ? `mechanics: ${meta.mechanics.join(", ")}` : "",
    `scripts: ${files.length}`,
    allServices.length ? `services: ${allServices.join(", ")}` : "",
    allRemotes.length ? `networking: ${allRemotes.join(", ")}` : "",
    `\nScript inventory:\n${files.map((f) => `  ${f.robloxPath} (${f.scriptType}, ${f.lineCount} lines)`).join("\n")}`,
  ].filter(Boolean).join("\n");

  return {
    id,
    gameSlug: meta.slug,
    gameName: meta.name,
    niche: meta.niche,
    chunkType: "summary",
    vectorizeIndex: nicheIndex(indexPrefix, meta.niche),
    r2Path: `${meta.slug}/chunks/${id}.txt`,
    title: `${meta.name} — game summary`,
    symbols: [],
    requiredModules: [],
    remotes: allRemotes,
    services: allServices,
    tags: ["summary"],
    qualityScore: meta.qualityScore ?? 0.5,
    content,
    embedText: [
      `game summary: ${meta.name}`,
      `niche: ${meta.niche}`,
      meta.mechanics?.join(", ") ?? "",
      allServices.join(", "),
    ].filter(Boolean).join("\n"),
  };
}

export function buildSystemChunks(meta: GameMeta, files: ScriptFile[], indexPrefix: string): RawChunk[] {
  const byFolder = new Map<string, ScriptFile[]>();
  for (const file of files) {
    const parts = file.filePath.replace(/^raw\//, "").split("/");
    const folder = parts.length > 2 ? parts.slice(0, -1).join("/") : parts[0];
    const group = byFolder.get(folder) ?? [];
    group.push(file);
    byFolder.set(folder, group);
  }

  const chunks: RawChunk[] = [];
  for (const [folder, group] of byFolder) {
    if (group.length < 2) continue;
    const id = randomUUID();
    const allServices = [...new Set(group.flatMap((f) => f.services))];
    const allSymbols = [...new Set(group.flatMap((f) => f.symbols))].slice(0, 40);
    const allRemotes = [...new Set(group.flatMap((f) => f.remotes))];
    const systemName = folder.split("/").pop() ?? folder;

    const content = group.map((f) => [
      `-- path: ${f.robloxPath} (${f.scriptType})`,
      f.source.slice(0, MAX_SCRIPT_CHARS),
    ].join("\n")).join("\n\n---\n\n");

    chunks.push({
      id,
      gameSlug: meta.slug,
      gameName: meta.name,
      niche: meta.niche,
      chunkType: "system",
      vectorizeIndex: nicheIndex(indexPrefix, meta.niche),
      r2Path: `${meta.slug}/chunks/${id}.txt`,
      title: `${meta.name} — ${systemName} system`,
      systemName,
      symbols: allSymbols,
      requiredModules: [],
      remotes: allRemotes,
      services: allServices,
      tags: ["system"],
      qualityScore: meta.qualityScore ?? 0.5,
      content,
      embedText: buildEmbedText(meta, { systemName, services: allServices, symbols: allSymbols }, content.slice(0, 600)),
    });
  }
  return chunks;
}

export function buildScriptChunks(meta: GameMeta, files: ScriptFile[], indexPrefix: string): RawChunk[] {
  return files.map((file): RawChunk => {
    const id = randomUUID();
    const truncated = file.source.length > MAX_SCRIPT_CHARS
      ? file.source.slice(0, MAX_SCRIPT_CHARS) + "\n-- [truncated]"
      : file.source;

    const content = [
      `-- path: ${file.robloxPath}`,
      `-- run_side: ${file.scriptType}`,
      file.services.length ? `-- services: ${file.services.join(", ")}` : "",
      truncated,
    ].filter(Boolean).join("\n");

    return {
      id,
      gameSlug: meta.slug,
      gameName: meta.name,
      niche: meta.niche,
      chunkType: "script" as ChunkType,
      vectorizeIndex: nicheIndex(indexPrefix, meta.niche),
      r2Path: `${meta.slug}/chunks/${id}.txt`,
      title: `${meta.name} — ${file.robloxPath}`,
      filePath: file.filePath,
      robloxPath: file.robloxPath,
      scriptType: file.scriptType,
      lineStart: 1,
      lineEnd: file.lineCount,
      symbols: file.symbols,
      requiredModules: file.requiredModules,
      remotes: file.remotes,
      services: file.services,
      tags: [file.scriptType],
      qualityScore: meta.qualityScore ?? 0.5,
      sourceHash: file.sourceHash,
      content,
      embedText: buildEmbedText(meta, {
        robloxPath: file.robloxPath,
        scriptType: file.scriptType,
        services: file.services,
        symbols: file.symbols,
      }, file.source.slice(0, 600)),
    };
  });
}

export function buildChunks(meta: GameMeta, files: ScriptFile[], indexPrefix: string): RawChunk[] {
  return [
    buildGameSummaryChunk(meta, files, indexPrefix),
    ...buildSystemChunks(meta, files, indexPrefix),
    ...buildScriptChunks(meta, files, indexPrefix),
  ];
}
