/**
 * embed-games.ts — ACID-safe chunk embedding for Roblox corpus games.
 *
 * Per-game guarantee (atomicity):
 *   Phase 1 — pure computation: fetch R2, build chunks, embed all (no writes)
 *   Phase 2 — write: R2 chunk files → Vectorize vectors → Postgres transaction
 *   On ANY failure in Phase 2: delete every R2 key uploaded + delete Vectorize
 *   vectors upserted this run → Postgres never touched → safe to retry
 *
 * Duplicate-safe: chunk IDs are deterministic (hash of slug+type+path+content).
 * Already-embedded chunks are skipped before Phase 1 begins.
 *
 * Usage:
 *   bun run scripts/embed-games.ts --games=10
 *   bun run scripts/embed-games.ts --games=all
 *   bun run scripts/embed-games.ts --slug=flood-escape
 *   bun run scripts/embed-games.ts --games=5 --dry-run
 *   bun run scripts/embed-games.ts --slug=flood-escape --cleanup
 */

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// ── Args + env ────────────────────────────────────────────────────────────────

const gamesArg    = process.argv.find((a) => a.startsWith("--games="))?.split("=")[1] ?? "10";
const slugArg     = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];
const DRY_RUN     = process.argv.includes("--dry-run");
const RE_VECTORIZE = process.argv.includes("--re-vectorize"); // re-push existing chunks to Vectorize only
const CLEANUP     = process.argv.includes("--cleanup"); // delete chunk rows, chunk R2 files, and Vectorize ids for --slug
const GAME_LIMIT  = gamesArg === "all" ? Infinity : parseInt(gamesArg);

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

const CF    = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const R2    = `${CF}/r2/buckets/${bucket}/objects`;
const pool  = new pg.Pool({ connectionString: databaseUrl });
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

async function r2Delete(key: string): Promise<void> {
  await fetch(`${R2}/${encKey(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  }).catch(() => undefined);
}

async function embedText(text: string): Promise<number[]> {
  const res = await fetch(`${CF}/ai/run/${embedModel}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Embed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { result: { data: number[][] } };
  return json.result.data[0];
}

async function vectorizeUpsert(indexName: string, vectors: VectorRow[]): Promise<void> {
  if (!vectors.length) return;

  const ndjson = vectors.map((v) => JSON.stringify({ id: v.id, values: v.values, metadata: v.metadata })).join("\n");
  const res = await fetch(`${CF}/vectorize/v2/indexes/${indexName}/upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/x-ndjson" },
    body: ndjson,
  });

  if (res.status === 404) {
    const body = await res.text();
    if (body.includes("Unable to authenticate request")) {
      throw new Error(`Vectorize auth failed for ${indexName}: ${body}`);
    }

    const createRes = await fetch(`${CF}/vectorize/v2/indexes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: indexName, config: { dimensions: 768, metric: "cosine" } }),
    });
    if (!createRes.ok && createRes.status !== 409) {
      throw new Error(`Vectorize create ${indexName}: ${createRes.status} ${await createRes.text()}`);
    }
    await vectorizeUpsert(indexName, vectors);
    return;
  }

  if (!res.ok) throw new Error(`Vectorize upsert: ${res.status} ${await res.text()}`);
  const json = await res.json() as { result?: { count?: number } };
  console.log(`   Vectorize: ${json.result?.count ?? "?"} vectors upserted to ${indexName}`);
}

async function vectorizeDelete(indexName: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await fetch(`${CF}/vectorize/v2/indexes/${indexName}/delete_by_ids`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  }).catch(() => undefined);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Chunk = {
  id: string; type: "summary" | "system" | "script";
  title: string; r2Path: string; content: string; embedText: string;
  filePath?: string; robloxPath?: string; scriptType?: string; systemName?: string;
  services: string[]; remotes: string[]; symbols: string[];
};

type VectorRow = {
  id: string; values: number[];
  metadata: Record<string, string | number>;
};

// ── Chunk ID (deterministic) ──────────────────────────────────────────────────

const chunkId = (slug: string, type: string, path: string, content: string) => {
  const h = createHash("sha256").update(`${slug}:${type}:${path}:${content.slice(0, 500)}`).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
};

// ── Metadata extraction ───────────────────────────────────────────────────────

const SVC_RX    = /game:GetService\(["'](\w+)["']\)/g;
const REMOTE_RX = /(?:FireServer|FireClient|FireAllClients|OnServerEvent|OnClientEvent|RemoteEvent|RemoteFunction)\b/g;
const FUNC_RX   = /(?:^|\n)\s*(?:local\s+)?function\s+([\w.]+)\s*\(/gm;

function extractMeta(src: string) {
  return {
    services: [...new Set([...src.matchAll(new RegExp(SVC_RX.source, "g"))].map((m) => m[1]))],
    remotes:  [...new Set([...src.matchAll(new RegExp(REMOTE_RX.source, "g"))].map((m) => m[0]))],
    symbols:  [...new Set([...src.matchAll(new RegExp(FUNC_RX.source, "gm"))].map((m) => m[1]))].slice(0, 40),
  };
}

const inferType = (p: string): string =>
  p.endsWith(".server.lua") || p.endsWith(".server.luau") ? "server"
  : p.endsWith(".client.lua") || p.endsWith(".client.luau") ? "client"
  : "module";

// ── Chunk builder (pure — no side effects) ────────────────────────────────────

function buildChunks(slug: string, name: string, niche: string, files: { path: string; source: string }[]): Chunk[] {
  const chunks: Chunk[] = [];

  // 1. Summary
  const allSvc = [...new Set(files.flatMap((f) => extractMeta(f.source).services))];
  const summaryContent = [`# ${name}`, `niche: ${niche}`, `scripts: ${files.length}`,
    allSvc.length ? `services: ${allSvc.join(", ")}` : "",
    `\nFiles:\n${files.map((f) => `  ${f.path}`).join("\n")}`,
  ].filter(Boolean).join("\n");

  chunks.push({
    id: chunkId(slug, "summary", "summary", summaryContent),
    type: "summary", title: `${name} — summary`,
    r2Path: `${slug}/chunks/summary.txt`, content: summaryContent,
    embedText: `game: ${name}\nniche: ${niche}\nservices: ${allSvc.join(", ")}`,
    services: allSvc, remotes: [], symbols: [],
  });

  // 2. System chunks (2+ scripts in same folder)
  const byFolder = new Map<string, typeof files>();
  for (const f of files) {
    const parts = f.path.replace(/^raw\//, "").split("/");
    const folder = parts.length > 2 ? parts.slice(0, -1).join("/") : parts[0];
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  for (const [folder, group] of byFolder) {
    if (group.length < 2) continue;
    const metas   = group.map((f) => extractMeta(f.source));
    const svcSet  = [...new Set(metas.flatMap((m) => m.services))];
    const symSet  = [...new Set(metas.flatMap((m) => m.symbols))].slice(0, 40);
    const remSet  = [...new Set(metas.flatMap((m) => m.remotes))];
    const sysName = folder.split("/").pop() ?? folder;
    const content = group.map((f) => `-- ${f.path}\n${f.source.slice(0, 4000)}`).join("\n\n---\n\n");
    chunks.push({
      id: chunkId(slug, "system", folder, content),
      type: "system", title: `${name} — ${sysName}`, systemName: sysName,
      r2Path: `${slug}/chunks/system-${createHash("sha256").update(folder).digest("hex").slice(0, 8)}.txt`,
      content, embedText: `game: ${name}\nniche: ${niche}\nsystem: ${sysName}\nservices: ${svcSet.join(", ")}\n${content.slice(0, 600)}`,
      services: svcSet, remotes: remSet, symbols: symSet,
    });
  }

  // 3. Script chunks (one per file)
  for (const file of files) {
    const meta  = extractMeta(file.source);
    const rPath = "game." + file.path.replace(/^raw\//, "").replace(/\.(server|client)?\.(lua|luau)$/, "").replace(/\.(lua|luau)$/, "").replace(/\//g, ".");
    const sType = inferType(file.path);
    const src   = file.source.length > 6000 ? file.source.slice(0, 6000) + "\n-- [truncated]" : file.source;
    const content = [`-- path: ${rPath}`, `-- run_side: ${sType}`, meta.services.length ? `-- services: ${meta.services.join(", ")}` : "", src].filter(Boolean).join("\n");
    chunks.push({
      id: chunkId(slug, "script", file.path, file.source),
      type: "script", title: `${name} — ${rPath}`,
      r2Path: `${slug}/chunks/script-${createHash("sha256").update(file.path).digest("hex").slice(0, 8)}.txt`,
      filePath: file.path, robloxPath: rPath, scriptType: sType, content,
      embedText: `game: ${name}\nniche: ${niche}\npath: ${rPath}\nrun_side: ${sType}\nservices: ${meta.services.join(", ")}\n${file.source.slice(0, 600)}`,
      services: meta.services, remotes: meta.remotes, symbols: meta.symbols,
    });
  }

  return chunks;
}

// ── Per-game ACID embedding ───────────────────────────────────────────────────

type EmbedResult = { slug: string; ok: boolean; chunks: number; skipped: number; error?: string };

async function embedGame(game: { id: string; slug: string; niche: string; name: string; r2Prefix: string }): Promise<EmbedResult> {
  const { slug, niche, name, r2Prefix, id: gameId } = game;
  const indexName = `${indexPrefix}-${niche}`;

  // ── Phase 0: fetch from R2 (read-only) ───────────────────────────────────

  const manifestRaw = await r2Get(`${r2Prefix}manifest.json`);
  if (!manifestRaw) return { slug, ok: false, chunks: 0, skipped: 0, error: "manifest.json not in R2" };
  const manifest: string[] = JSON.parse(manifestRaw);

  const files: { path: string; source: string }[] = [];
  for (const filePath of manifest) {
    const source = await r2Get(`${r2Prefix}${filePath}`);
    if (source) files.push({ path: filePath, source });
    await sleep(30);
  }
  if (!files.length) return { slug, ok: false, chunks: 0, skipped: 0, error: "no script files in R2" };

  // ── Phase 1: pure computation — build chunks, filter new, embed all ───────

  const allChunks = buildChunks(slug, name, niche, files);

  const existingIds = new Set(
    (await prisma.corpusChunk.findMany({
      where: { gameId, vectorizeId: { in: allChunks.map((c) => c.id) } },
      select: { vectorizeId: true },
    })).map((c) => c.vectorizeId),
  );

  const newChunks = allChunks.filter((c) => !existingIds.has(c.id));
  const skipped   = allChunks.length - newChunks.length;

  if (!newChunks.length) return { slug, ok: true, chunks: 0, skipped };
  if (DRY_RUN) return { slug, ok: true, chunks: newChunks.length, skipped };

  // Embed everything BEFORE writing anything (pure computation phase)
  const vectors: VectorRow[] = [];
  for (const chunk of newChunks) {
    const values = await embedText(chunk.embedText);
    vectors.push({
      id: chunk.id, values,
      metadata: { gameSlug: slug, gameName: name, niche, chunkType: chunk.type, r2Path: chunk.r2Path, robloxPath: chunk.robloxPath ?? "", qualityScore: 0.7 },
    });
    await sleep(50);
  }

  // ── Phase 2: writes with rollback on any failure ──────────────────────────

  const uploadedR2Keys: string[]       = [];
  const upsertedVectorIds: string[]    = [];

  try {
    // 2a. Upload chunk content to R2
    for (const chunk of newChunks) {
      await r2Put(chunk.r2Path, chunk.content);
      uploadedR2Keys.push(chunk.r2Path);
    }

    // 2b. Upsert vectors to Vectorize
    await vectorizeUpsert(indexName, vectors);
    upsertedVectorIds.push(...vectors.map((v) => v.id));

    // 2c. Write chunk rows + mark game ingested — single Postgres transaction
    // timeout scales with chunk count: 2s base + 500ms per chunk, capped at 120s
    const txTimeout = Math.min(2000 + newChunks.length * 500, 120_000);
    await prisma.$transaction(async (tx) => {
      // Bulk-insert new chunks, skip conflicts (already inserted by a prior run)
      await tx.corpusChunk.createMany({
        data: newChunks.map((chunk) => ({
          id: chunk.id, gameId,
          chunkType: chunk.type,
          vectorizeIndex: indexName, vectorizeId: chunk.id,
          r2Path: chunk.r2Path, title: chunk.title,
          systemName: chunk.systemName ?? null,
          filePath: chunk.filePath ?? null,
          robloxPath: chunk.robloxPath ?? null,
          scriptType: (chunk.scriptType as "server" | "client" | "module" | "shared" | "unknown") ?? null,
          symbols: chunk.symbols, remotes: chunk.remotes,
          services: chunk.services, requiredModules: [],
          tags: [chunk.type], qualityScore: 0.7,
        })),
        skipDuplicates: true,
      });
      await tx.game.update({
        where: { id: gameId },
        data: { ingested: true, ingestedAt: new Date(), scriptCount: files.length },
      });
    }, { timeout: txTimeout, maxWait: 10_000 });

    return { slug, ok: true, chunks: newChunks.length, skipped };

  } catch (err) {
    // ── Rollback: delete everything written this run ──────────────────────
    console.error(`  ↩  ${slug}: rolling back (${uploadedR2Keys.length} R2 keys, ${upsertedVectorIds.length} vectors)`);
    await Promise.allSettled([
      ...uploadedR2Keys.map(r2Delete),
      vectorizeDelete(indexName, upsertedVectorIds),
    ]);
    return {
      slug, ok: false, chunks: 0, skipped,
      error: `${err instanceof Error ? err.message : err} — rolled back`,
    };
  }
}

// ── Re-vectorize mode: push existing Postgres chunks back to Vectorize ────────

async function reVectorize(slug: string) {
  const game = await prisma.game.findUnique({ where: { slug } });
  if (!game) { console.error(`Game "${slug}" not found in Postgres`); return; }

  const chunks = await prisma.corpusChunk.findMany({ where: { gameId: game.id } });
  if (!chunks.length) { console.log(`No chunks found for "${slug}"`); return; }

  console.log(`Re-vectorizing ${chunks.length} chunks for "${slug}"...\n`);

  const vectors: VectorRow[] = [];
  for (const chunk of chunks) {
    const content = await r2Get(chunk.r2Path);
    if (!content) { console.warn(`  ⚠ missing R2: ${chunk.r2Path}`); continue; }
    const values = await embedText(content.slice(0, 2000));
    vectors.push({
      id: chunk.vectorizeId,
      values,
      metadata: {
        gameSlug: slug, gameName: game.name, niche: game.niche,
        chunkType: chunk.chunkType, r2Path: chunk.r2Path,
        robloxPath: chunk.robloxPath ?? "", qualityScore: chunk.qualityScore,
      },
    });
    await sleep(50);
  }

  if (!vectors.length) { console.log("Nothing to upsert."); return; }
  if (DRY_RUN) { console.log(`[DRY RUN] Would upsert ${vectors.length} vectors`); return; }

  const indexName = chunks[0].vectorizeIndex;
  await vectorizeUpsert(indexName, vectors);
  console.log(`✓ ${vectors.length} vectors upserted to ${indexName}`);
}

// ── Cleanup mode: remove generated chunk artifacts for one game ───────────────

async function cleanupGame(slug: string) {
  const game = await prisma.game.findUnique({ where: { slug }, include: { chunks: true } });
  if (!game) { console.error(`Game "${slug}" not found in Postgres`); return; }

  if (!game.chunks.length) {
    console.log(`No chunk rows found for "${slug}". Marking game as not ingested.`);
    if (!DRY_RUN) await prisma.game.update({ where: { id: game.id }, data: { ingested: false, ingestedAt: null } });
    return;
  }

  const r2Keys = [...new Set(game.chunks.map((c) => c.r2Path))];
  const byIndex = new Map<string, string[]>();
  for (const chunk of game.chunks) {
    byIndex.set(chunk.vectorizeIndex, [...(byIndex.get(chunk.vectorizeIndex) ?? []), chunk.vectorizeId]);
  }

  console.log(`Cleaning "${slug}": ${game.chunks.length} DB rows, ${r2Keys.length} R2 chunk files, ${byIndex.size} Vectorize index(es)`);
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would delete R2: ${r2Keys.join(", ")}`);
    for (const [indexName, ids] of byIndex) console.log(`[DRY RUN] Would delete ${ids.length} vectors from ${indexName}`);
    return;
  }

  for (const [indexName, ids] of byIndex) await vectorizeDelete(indexName, ids);
  await Promise.allSettled(r2Keys.map(r2Delete));
  await prisma.$transaction([
    prisma.corpusChunk.deleteMany({ where: { gameId: game.id } }),
    prisma.game.update({ where: { id: game.id }, data: { ingested: false, ingestedAt: null } }),
  ]);
  console.log(`✓ cleaned "${slug}"`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const query = {
  where: slugArg ? { slug: slugArg } : { ingested: false },
  orderBy: { createdAt: "asc" as const },
  ...(Number.isFinite(GAME_LIMIT) ? { take: GAME_LIMIT } : {}),
};

if (RE_VECTORIZE) {
  if (!slugArg) { console.error("--re-vectorize requires --slug=<game>"); process.exit(1); }
  await reVectorize(slugArg);
  await pool.end();
  process.exit(0);
}

if (CLEANUP) {
  if (!slugArg) { console.error("--cleanup requires --slug=<game>"); process.exit(1); }
  await cleanupGame(slugArg);
  await pool.end();
  process.exit(0);
}

const games = await prisma.game.findMany(query);

if (!games.length) {
  console.log(slugArg ? `"${slugArg}" not found` : "No un-ingested games — run sync-corpus.ts first");
  await pool.end();
  process.exit(0);
}

console.log(`Embedding ${games.length} game(s)${DRY_RUN ? " (DRY RUN)" : ""}\n`);

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
console.log(`\n${done} games | ${totalChunks} new chunks | ${totalSkipped} already embedded | ${failed} failed`);
if (failed > 0) console.log("Failed games were fully rolled back — safe to retry.");
