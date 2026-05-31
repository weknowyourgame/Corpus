import { globalScriptIndexer } from "./retrieval.ts";
import { retrieveDocs } from "./docs.ts";
import { retrieveCorpusContext } from "./corpus/retrieve.ts";

const MAX_SOURCE_CHARS = 2000;

export async function buildRagContext(
  query: string,
  sessionId: string,
  opts: { codeLimit?: number; docLimit?: number } = {},
  signal?: AbortSignal,
): Promise<string | null> {
  const { codeLimit = 5, docLimit = 2 } = opts;
  const codeChunks = globalScriptIndexer.retrieve(sessionId, query, codeLimit);
  const docChunks = retrieveDocs(query, docLimit);

  const corpusResult = await retrieveCorpusContext({ query, signal }).catch((err) => {
    console.warn("[rag] corpus retrieval failed:", err);
    return { chunks: [], detectedNiche: null, totalFound: 0 };
  });

  if (!codeChunks.length && !docChunks.length && !corpusResult.chunks.length) return null;

  const lines: string[] = ["<roblox_retrieved_context>"];
  lines.push("Authority order: live project > official Roblox docs > open-source corpus. Prefer live project above all.");

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

  if (corpusResult.chunks.length) {
    lines.push("\n[Open-source Roblox corpus examples]");
    lines.push("Reference only — adapt to the live project's architecture, never blindly copy.");
    for (const chunk of corpusResult.chunks) {
      lines.push(`\ngame: ${chunk.gameName} | niche: ${chunk.niche} | type: ${chunk.chunkType} | quality: ${chunk.qualityScore.toFixed(2)}`);
      if (chunk.robloxPath) lines.push(`path: ${chunk.robloxPath}`);
      if (chunk.services.length) lines.push(`services: ${chunk.services.join(", ")}`);
      lines.push("```luau");
      lines.push(chunk.content);
      lines.push("```");
    }
  }

  lines.push("</roblox_retrieved_context>");
  return lines.join("\n");
}
