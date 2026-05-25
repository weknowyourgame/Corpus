// @vitest-environment node
import { createHash } from "node:crypto";

export interface ScriptChunk {
  path: string;
  className: string;
  runSide: "server" | "client" | "shared" | "unknown";
  source: string;
  revision: string;
  symbols: string[];
  lastSeen: number;
}

function inferClass(path: string): string {
  if (path.toLowerCase().includes("localscript")) return "LocalScript";
  if (path.toLowerCase().includes("modulescript")) return "ModuleScript";
  return "Script";
}

function inferRunSide(className: string, path: string): ScriptChunk["runSide"] {
  if (className === "LocalScript") return "client";
  if (className === "Script") return "server";
  if (className === "ModuleScript") {
    if (/ServerScriptService|ServerStorage/i.test(path)) return "server";
    if (/StarterPlayer|StarterGui|StarterCharacter/i.test(path)) return "client";
    return "shared";
  }
  return "unknown";
}

function extractSymbols(source: string): string[] {
  const symbols: string[] = [];
  const funcRx = /(?:^|\n)\s*(?:local\s+)?function\s+([\w.]+)\s*\(/gm;
  const keyRx = /(?:^|\n)\s*(\w+)\s*=\s*function/gm;
  let m: RegExpExecArray | null;
  while ((m = funcRx.exec(source)) !== null) symbols.push(m[1]);
  while ((m = keyRx.exec(source)) !== null) symbols.push(m[1]);
  return [...new Set(symbols)].slice(0, 40);
}

function hash12(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

export class ScriptIndexer {
  private readonly sessions = new Map<string, Map<string, ScriptChunk>>();

  index(sessionId: string, path: string, source: string, className?: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    const cls = className ?? inferClass(path);
    this.sessions.get(sessionId)!.set(path, {
      path,
      className: cls,
      runSide: inferRunSide(cls, path),
      source,
      revision: hash12(source),
      symbols: extractSymbols(source),
      lastSeen: Date.now(),
    });
  }

  retrieve(sessionId: string, query: string, limit = 5): ScriptChunk[] {
    const session = this.sessions.get(sessionId);
    if (!session?.size) return [];
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (!terms.length) return [...session.values()].slice(0, limit);
    const scored = [...session.values()].map((chunk) => {
      let score = 0;
      for (const term of terms) {
        if (chunk.path.toLowerCase().includes(term)) score += 3;
        if (chunk.symbols.some((s) => s.toLowerCase().includes(term))) score += 2;
        if (chunk.source.toLowerCase().includes(term)) score += 1;
      }
      return { chunk, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.chunk);
  }

  has(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.size ?? 0) > 0;
  }

  size(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const globalScriptIndexer = new ScriptIndexer();
