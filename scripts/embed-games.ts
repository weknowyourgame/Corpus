/**
 * embed-games.ts — Creates chunks + embeddings for ingested games.
 *
 * Reads from R2, embeds via Workers AI, upserts to Vectorize, writes to Postgres.
 * 100% duplicate-safe: chunk IDs are deterministic (hash of slug+path+content).
 * Re-running is always safe — already-embedded chunks are skipped.
 *
 * Usage:
 *   bun run scripts/embed-games.ts --games=10
 *   bun run scripts/embed-games.ts --games=all
 *   bun run scripts/embed-games.ts --slug=flood-escape
 *   bun run scripts/embed-games.ts --games=5 --dry-run
 */

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// ── Args ──────────────────────────────────────────────────────────────────────

const gamesArg  = process.argv.find((a) => a.startsWith("--games="))?.split("=")[1] ?? "10";
const slugArg   = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];
const DRY_RUN   = process.argv.includes("--dry-run");
const GAME_LIMIT = gamesArg === "all" ? Infinity : parseInt(gamesArg);

// ── Env ───────────────────────────────────────────────────────────────────────

const accountId   = process.env.CLOUDFLARE_ACCOUNT_ID!;
const apiToken    = process.env.CLOUDFLARE_API_TOKEN!;
const bucket      = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const embedModel  = process.env.CLOUDFLARE_WORKERS_AI_EMBED_MODEL ?? "@cf/baai/bge-base-en-v1.5";
const indexPrefix = process.env.CLOUDFLARE_NICHE_INDEX_PREFIX ?? "roblox";
const databaseUrl = process.env.DATABASE_URL!;

if (!accountId || !apiToken || !databaseUrl) {
  console.error("Missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DATABASE_URL");
  process.exit(1);
}

const CF = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const R2 = `${CF}/r2/buckets/${bucket}/objects`;
const pool   = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);

const sleep  = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

// ── Cloudflare helpers ────────────────────────────────────────────────────────

async function r2Get(key: string): Promise<string | null> {
  const res = await fetch(`${R2}/${encKey(key)}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  return res.ok ? res.text() : null;
}

async function r2Put(key: string, body: string): Promise<void> {
  const res = await fetch(`${R2}/${encKey(key)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain; charset=utf-8" },
    body,
  });
  if (!res.ok) throw new Error(`R2 put ${key}: ${res.status} ${await res.text()}`);
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${CF}/ai/run/${embedModel}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { result: { data: number[][] } };
  return json.result.data[0];
}

async function upsertVectors(indexName: string, vectors: { id: string; values: number[]; metadata: Record<string, string | number> }[]): Promise<void> {
  if (!vectors.length) return;
  const ndjson = vectors.map((v) => JSON.stringify({ id: v.id, values: v.values, metadata: v.metadata })).join("\n");
  const res = await fetch(`${CF}/vectorize/v2/indexes/${indexName}/upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/x-ndjson" },
    body: ndjson,
  });
  if (res.status === 404) {
    // Create index on demand
    await fetch(`${CF}/vectorize/v2/indexes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: indexName, config: { dimensions: 768, metric: "cosine" } }),
    });
    await upsertVectors(indexName, vectors);
    return;
  }
  if (!res.ok) throw new Error(`Vectorize upsert: ${res.status} ${await res.text()}`);
}

// ── Deterministic chunk ID ────────────────────────────────────────────────────
// Same game + same file + same content → same ID always. Safe to re-run.

function chunkId(slug: string, type: string, path: string, content: string): string {
  return createHash("sha256")
    .update(`${slug}:${type}:${path}:${content.slice(0, 500)}`)
    .digest("hex")
    .slice(0, 36);
}

// ── Script metadata extraction ────────────────────────────────────────────────

const SVC_RX    = /game:GetService\(["'](\w+)["']\)/g;
const REMOTE_RX = /(?:FireServer|FireClient|FireAllClients|OnServerEvent|OnClientEvent|RemoteEvent|RemoteFunction)\b/g;
const FUNC_RX   = /(?:^|\n)\s*(?:local\s+)?function\s+([\w.]+)\s*\(/gm;

function extractMeta(source: string) {
  const services = [...new Set([...source.matchAll(new RegExp(SVC_RX.source, "g"))].map((m) => m[1]))];
  const remotes  = [...new Set([...source.matchAll(new RegExp(REMOTE_RX.source, "g"))].map((m) => m[0]))];
  const symbols  = [...new Set([...source.matchAll(new RegExp(FUNC_RX.source, "gm"))].map((m) => m[1]))].slice(0, 40);
  return { services, remotes, symbols };
}

function inferScriptType(path: string): string {
  if (path.endsWith(".server.lua") || path.endsWith(".server.luau")) return "server";
  if (path.endsWith(".client.lua") || path.endsWith(".client.luau")) return "client";
  return "module";
}

// ── Per-game embedding ────────────────────────────────────────────────────────

type EmbedResult = { slug: string; ok: boolean; chunks: number; skipped: number; error?: string };

async function embedGame(game: { id: string; slug: string; niche: string; name: string; r2Prefix: string }): Promise<EmbedResult> {
  const { slug, niche, name, r2Prefix, id: gameId } = game;
  const indexName = `${indexPrefix}-${niche}`;

  // Fetch manifest from R2
  const manifestRaw = await r2Get(`${r2Prefix}manifest.json`);
  if (!manifestRaw) return { slug, ok: false, chunks: 0, skipped: 0, error: "manifest.json not found in R2" };
  const manifest: string[] = JSON.parse(manifestRaw);

  // Fetch all scripts from R2
  const files: { path: string; source: string }[] = [];
  for (const filePath of manifest) {
    const source = await r2Get(`${r2Prefix}${filePath}`);
    if (source) files.push({ path: filePath, source });
    await sleep(30); // gentle on R2
  }

  if (!files.length) return { slug, ok: false, chunks: 0, skipped: 0, error: "no script files found in R2" };

  // Build chunks
  type Chunk = {
    id: string; type: string; title: string; r2Path: string; content: string; embedText: string;
    filePath?: string; robloxPath?: string; scriptType?: string;
    services: string[]; remotes: string[]; symbols: string[]; systemName?: string;
  };

  const chunks: Chunk[] = [];

  // 1. Game summary chunk
  const allServices = [...new Set(files.flatMap((f) => extractMeta(f.source).services))];
  const summaryContent = [
    `# ${name}`, `niche: ${niche}`,
    `scripts: ${files.length}`,
    allServices.length ? `services: ${allServices.join(", ")}` : "",
    `\nFiles:\n${files.map((f) => `  ${f.path}`).join("\n")}`,
  ].filter(Boolean).join("\n");

  chunks.push({
    id: chunkId(slug, "summary", "summary", summaryContent),
    type: "summary", title: `${name} — summary`, r2Path: `${slug}/chunks/summary.txt`,
    content: summaryContent,
    embedText: `game: ${name}\nniche: ${niche}\nservices: ${allServices.join(", ")}`,
    services: allServices, remotes: [], symbols: [],
  });

  // 2. System chunks (group by folder — 2+ scripts)
  const byFolder = new Map<string, typeof files>();
  for (const f of files) {
    const parts = f.path.replace(/^raw\//, "").split("/");
    const folder = parts.length > 2 ? parts.slice(0, -1).join("/") : parts[0];
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  for (const [folder, group] of byFolder) {
    if (group.length < 2) continue;
    const meta    = group.flatMap((f) => { const m = extractMeta(f.source); return [m]; });
    const svcSet  = [...new Set(meta.flatMap((m) => m.services))];
    const symSet  = [...new Set(meta.flatMap((m) => m.symbols))].slice(0, 40);
    const remSet  = [...new Set(meta.flatMap((m) => m.remotes))];
    const sysName = folder.split("/").pop() ?? folder;
    const content = group.map((f) => `-- ${f.path}\n${f.source.slice(0, 4000)}`).join("\n\n---\n\n");
    chunks.push({
      id: chunkId(slug, "system", folder, content),
      type: "system", title: `${name} — ${sysName}`, r2Path: `${slug}/chunks/system-${sysName}.txt`,
      systemName: sysName, content,
      embedText: `game: ${name}\nniche: ${niche}\nsystem: ${sysName}\nservices: ${svcSet.join(", ")}\n${content.slice(0, 600)}`,
      services: svcSet, remotes: remSet, symbols: symSet,
    });
  }

  // 3. Script chunks (one per file)
  for (const file of files) {
    const meta       = extractMeta(file.source);
    const robloxPath = "game." + file.path.replace(/^raw\//, "").replace(/\.(server|client)?\.(lua|luau)$/, "").replace(/\.(lua|luau)$/, "").replace(/\//g, ".");
    const scriptType = inferScriptType(file.path);
    const truncated  = file.source.length > 6000 ? file.source.slice(0, 6000) + "\n-- [truncated]" : file.source;
    const content    = [`-- path: ${robloxPath}`, `-- run_side: ${scriptType}`, meta.services.length ? `-- services: ${meta.services.join(", ")}` : "", truncated].filter(Boolean).join("\n");
    chunks.push({
      id: chunkId(slug, "script", file.path, file.source),
      type: "script", title: `${name} — ${robloxPath}`,
      r2Path: `${slug}/chunks/script-${createHash("sha256").update(file.path).digest("hex").slice(0, 8)}.txt`,
      filePath: file.path, robloxPath, scriptType, content,
      embedText: `game: ${name}\nniche: ${niche}\npath: ${robloxPath}\nrun_side: ${scriptType}\nservices: ${meta.services.join(", ")}\n${file.source.slice(0, 600)}`,
      services: meta.services, remotes: meta.remotes, symbols: meta.symbols,
    });
  }

  // Check which chunks are already in Postgres (by vectorizeId = chunk id)
  const existingIds = new Set(
    (await prisma.corpusChunk.findMany({ where: { gameId, vectorizeId: { in: chunks.map((c) => c.id) } }, select: { vectorizeId: true } }))
      .map((c) => c.vectorizeId),
  );

  const newChunks = chunks.filter((c) => !existingIds.has(c.id));
  const skipped   = chunks.length - newChunks.length;

  if (!newChunks.length) return { slug, ok: true, chunks: 0, skipped };

  if (DRY_RUN) return { slug, ok: true, chunks: newChunks.length, skipped };

  // Embed + upsert to Vectorize + upload chunk to R2
  const vectors: { id: string; values: number[]; metadata: Record<string, string | number> }[] = [];

  for (const chunk of newChunks) {
    const values = await embed(chunk.embedText);
    vectors.push({
      id: chunk.id, values,
      metadata: { gameSlug: slug, gameName: name, niche, chunkType: chunk.type, r2Path: chunk.r2Path, robloxPath: chunk.robloxPath ?? "", qualityScore: 0.7 },
    });
    await r2Put(chunk.r2Path, chunk.content);
    await sleep(50);
  }

  await upsertVectors(indexName, vectors);

  // Write chunk rows to Postgres
  for (const chunk of newChunks) {
    await prisma.corpusChunk.upsert({
      where:  { vectorizeId: chunk.id },
      update: { r2Path: chunk.r2Path },
      create: {
        id: chunk.id, gameId, chunkType: chunk.type as "summary" | "system" | "script",
        vectorizeIndex: indexName, vectorizeId: chunk.id, r2Path: chunk.r2Path,
        title: chunk.title, systemName: chunk.systemName ?? null,
        filePath: chunk.filePath ?? null, robloxPath: chunk.robloxPath ?? null,
        scriptType: (chunk.scriptType as "server" | "client" | "module" | "shared" | "unknown") ?? null,
        symbols: chunk.symbols, remotes: chunk.remotes, services: chunk.services,
        requiredModules: [], tags: [chunk.type], qualityScore: 0.7,
      },
    });
  }

  // Mark game as fully ingested
  await prisma.game.update({ where: { id: gameId }, data: { ingested: true, ingestedAt: new Date(), scriptCount: files.length } });

  return { slug, ok: true, chunks: newChunks.length, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let query: Parameters<typeof prisma.game.findMany>[0] = {
  where: slugArg ? { slug: slugArg } : { ingested: false },
  orderBy: { createdAt: "asc" },
};
if (Number.isFinite(GAME_LIMIT)) (query as any).take = GAME_LIMIT;

const games = await prisma.game.findMany(query);

if (!games.length) {
  console.log(slugArg ? `Game "${slugArg}" not found in Postgres` : "No un-ingested games found. All done or run sync-corpus first.");
  await pool.end();
  process.exit(0);
}

const label = DRY_RUN ? " (DRY RUN)" : "";
console.log(`Embedding ${games.length} game(s)${label}\n`);

let done = 0, failed = 0, totalChunks = 0, totalSkipped = 0;

for (const game of games) {
  const r = await embedGame(game as { id: string; slug: string; niche: string; name: string; r2Prefix: string });
  if (r.ok) {
    const tag = r.chunks === 0 ? "already done" : `${r.chunks} new chunks`;
    console.log(`  ✓  ${r.slug}  ${tag}${r.skipped ? ` (${r.skipped} skipped)` : ""}`);
    totalChunks += r.chunks;
    totalSkipped += r.skipped;
    done++;
  } else {
    console.log(`  ✗  ${r.slug}: ${r.error}`);
    failed++;
  }
}

await pool.end();
console.log(`\n${done} games | ${totalChunks} new chunks | ${totalSkipped} skipped (already embedded) | ${failed} failed`);
