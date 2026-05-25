import { globalScriptIndexer } from "./retrieval.ts";
import { retrieveDocs } from "./docs.ts";

const MAX_SOURCE_CHARS = 2000;

export function buildRagContext(
  query: string,
  sessionId: string,
  opts: { codeLimit?: number; docLimit?: number } = {},
): string | null {
  const { codeLimit = 5, docLimit = 2 } = opts;
  const codeChunks = globalScriptIndexer.retrieve(sessionId, query, codeLimit);
  const docChunks = retrieveDocs(query, docLimit);
  if (!codeChunks.length && !docChunks.length) return null;

  const lines: string[] = ["<roblox_retrieved_context>"];
  lines.push("Authority order: live project > official docs. Prefer project context over examples.");

  if (codeChunks.length) {
    lines.push("\n[Live Studio project scripts]");
    for (const chunk of codeChunks) {
      lines.push(`\npath: ${chunk.path}`);
      lines.push(`class: ${chunk.className} | run_side: ${chunk.runSide}`);
      if (chunk.symbols.length) lines.push(`symbols: ${chunk.symbols.join(", ")}`);
      lines.push("```luau");
      const src = chunk.source.length > MAX_SOURCE_CHARS
        ? chunk.source.slice(0, MAX_SOURCE_CHARS) + "\n-- [truncated]"
        : chunk.source;
      lines.push(src);
      lines.push("```");
    }
  }

  if (docChunks.length) {
    lines.push("\n[Roblox API reference]");
    for (const doc of docChunks) {
      lines.push(`\ntopic: ${doc.topic}`);
      lines.push(doc.content);
    }
  }

  lines.push("</roblox_retrieved_context>");
  return lines.join("\n");
}
