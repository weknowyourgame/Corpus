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
 *   bun run scripts/embed-games.ts --slug=flood-escape --backfill-metadata
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { filePathToRobloxPath, parseScriptMetadata } from "../server/agent/corpus/extract.ts";
import type { GameMeta, ScriptFile, ScriptType } from "../server/agent/corpus/types.ts";

// ── Args + env ────────────────────────────────────────────────────────────────

const gamesArg    = process.argv.find((a) => a.startsWith("--games="))?.split("=")[1] ?? "10";
const slugArg     = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];
const DRY_RUN     = process.argv.includes("--dry-run");
const RE_VECTORIZE = process.argv.includes("--re-vectorize"); // re-push existing chunks to Vectorize only
const CLEANUP     = process.argv.includes("--cleanup"); // delete chunk rows, chunk R2 files, and Vectorize ids for --slug
const BACKFILL_METADATA = process.argv.includes("--backfill-metadata"); // update Postgres metadata only
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
  lineStart?: number; lineEnd?: number; sourceHash?: string;
  services: string[]; remotes: string[]; symbols: string[]; requiredModules: string[];
  tags: string[]; qualityScore: number;
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

// ── Metadata helpers ─────────────────────────────────────────────────────────

type LocalMeta = Partial<GameMeta> & {
  subNiches?: string[];
  sub_niches?: string[];
  subniches?: string[];
  quality?: number;
};

const CONVERTED = join(homedir(), "stud", "games", "converted");

function unique(values: string[], limit = Infinity): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function readLocalMeta(slug: string): LocalMeta {
  const metaPath = join(CONVERTED, slug, "meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as LocalMeta;
  } catch (err) {
    console.warn(`  ⚠ ${slug}: could not read local meta.json (${err instanceof Error ? err.message : err})`);
    return {};
  }
}

function normalizeSubniches(meta: LocalMeta): string[] | undefined {
  return meta.subniches ?? meta.subNiches ?? meta.sub_niches;
}

function inferMechanics(slug: string, services: string[], folders: string[]): string[] {
  const haystack = `${slug} ${folders.join(" ")} ${services.join(" ")}`.toLowerCase();
  const mechanics: string[] = [];
  if (/\b(wave|round|spawn|enemy|tower|defense)\b/.test(haystack)) mechanics.push("wave progression");
  if (/\b(datastore|leaderstats|save|profile)\b/.test(haystack)) mechanics.push("player progression");
  if (/\b(remoteevent|remotefunction|replicatedstorage)\b/.test(haystack)) mechanics.push("client-server networking");
  if (/\b(gui|startergui|screen|ui|hud)\b/.test(haystack)) mechanics.push("user interface");
  if (/\b(weapon|gun|combat|damage|health)\b/.test(haystack)) mechanics.push("combat");
  if (/\b(pet|egg|rebirth|click|cash|coin)\b/.test(haystack)) mechanics.push("economy");
  return unique(mechanics, 8);
}

function toScriptFiles(files: { path: string; source: string }[]): ScriptFile[] {
  return files.map((file) => ({
    filePath: file.path,
    robloxPath: filePathToRobloxPath(file.path),
    ...parseScriptMetadata(file.source, file.path),
  }));
}

function folderName(filePath: string): string {
  const parts = filePath.replace(/^raw\//, "").split("/");
  return parts.length > 2 ? parts.slice(0, -1).join("/") : parts[0];
}

function buildSummaryText(meta: GameMeta, files: ScriptFile[]): string {
  const services = unique(files.flatMap((f) => f.services));
  const remotes = unique(files.flatMap((f) => f.remotes));
  const folders = unique(files.map((f) => folderName(f.filePath)), 12);
  return [
    `${meta.name} is a ${meta.niche} Roblox game corpus entry with ${files.length} scripts.`,
    services.length ? `Top services: ${services.slice(0, 8).join(", ")}.` : "Top services: none detected.",
    remotes.length ? `Remote usage: ${remotes.slice(0, 8).join(", ")}.` : "Remote usage: none detected.",
    folders.length ? `Major systems/folders: ${folders.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

function legacySummaryServices(files: ScriptFile[]): string[] {
  // Compatibility only: summary chunk IDs historically hashed GetService-only content.
  const serviceRx = /game:GetService\(["'](\w+)["']\)/g;
  return unique(files.flatMap((file) => [...file.source.matchAll(serviceRx)].map((m) => m[1])));
}

// ── Chunk builder (pure — no side effects) ────────────────────────────────────

function buildChunks(meta: GameMeta, files: ScriptFile[]): Chunk[] {
  const chunks: Chunk[] = [];
  const { slug, name, niche } = meta;
  const qualityScore = meta.qualityScore ?? 0.7;

  // 1. Summary
  const allSvc = unique(files.flatMap((f) => f.services));
  const allRemotes = unique(files.flatMap((f) => f.remotes));
  const idSvc = legacySummaryServices(files);
  const summaryContent = [`# ${name}`, `niche: ${niche}`, `scripts: ${files.length}`,
    idSvc.length ? `services: ${idSvc.join(", ")}` : "",
    `\nFiles:\n${files.map((f) => `  ${f.filePath}`).join("\n")}`,
  ].filter(Boolean).join("\n");

  chunks.push({
    id: chunkId(slug, "summary", "summary", summaryContent),
    type: "summary", title: `${name} — summary`,
    r2Path: `${slug}/chunks/summary.txt`, content: summaryContent,
    embedText: `game: ${name}\nniche: ${niche}\nservices: ${allSvc.join(", ")}`,
    services: allSvc, remotes: allRemotes, symbols: [], requiredModules: [],
    tags: ["summary"], qualityScore,
  });

  // 2. System chunks (2+ scripts in same folder)
  const byFolder = new Map<string, ScriptFile[]>();
  for (const f of files) {
    const folder = folderName(f.filePath);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  for (const [folder, group] of byFolder) {
    if (group.length < 2) continue;
    const svcSet  = unique(group.flatMap((f) => f.services));
    const symSet  = unique(group.flatMap((f) => f.symbols), 40);
    const remSet  = unique(group.flatMap((f) => f.remotes));
    const reqSet  = unique(group.flatMap((f) => f.requiredModules), 40);
    const sysName = folder.split("/").pop() ?? folder;
    const content = group.map((f) => `-- ${f.filePath}\n${f.source.slice(0, 4000)}`).join("\n\n---\n\n");
    chunks.push({
      id: chunkId(slug, "system", folder, content),
      type: "system", title: `${name} — ${sysName}`, systemName: sysName,
      r2Path: `${slug}/chunks/system-${createHash("sha256").update(folder).digest("hex").slice(0, 8)}.txt`,
      content, embedText: `game: ${name}\nniche: ${niche}\nsystem: ${sysName}\nservices: ${svcSet.join(", ")}\n${content.slice(0, 600)}`,
      services: svcSet, remotes: remSet, symbols: symSet, requiredModules: reqSet,
      tags: ["system"], qualityScore,
    });
  }

  // 3. Script chunks (one per file)
  for (const file of files) {
    const rPath = file.robloxPath;
    const sType = file.scriptType;
    const src   = file.source.length > 6000 ? file.source.slice(0, 6000) + "\n-- [truncated]" : file.source;
    const content = [`-- path: ${rPath}`, `-- run_side: ${sType}`, file.services.length ? `-- services: ${file.services.join(", ")}` : "", src].filter(Boolean).join("\n");
    chunks.push({
      id: chunkId(slug, "script", file.filePath, file.source),
      type: "script", title: `${name} — ${rPath}`,
      r2Path: `${slug}/chunks/script-${createHash("sha256").update(file.filePath).digest("hex").slice(0, 8)}.txt`,
      filePath: file.filePath, robloxPath: rPath, scriptType: sType, content,
      lineStart: 1, lineEnd: file.lineCount, sourceHash: file.sourceHash,
      embedText: `game: ${name}\nniche: ${niche}\npath: ${rPath}\nrun_side: ${sType}\nservices: ${file.services.join(", ")}\n${file.source.slice(0, 600)}`,
      services: file.services, remotes: file.remotes, symbols: file.symbols,
      requiredModules: file.requiredModules, tags: [sType], qualityScore,
    });
  }

  return chunks;
}

// ── Per-game ACID embedding ───────────────────────────────────────────────────

type EmbedResult = { slug: string; ok: boolean; chunks: number; skipped: number; error?: string };
type GameRow = { id: string; slug: string; niche: string; name: string; r2Prefix: string; subniches?: string[]; mechanics?: string[]; services?: string[]; qualityScore?: number };
type PreparedGame = { meta: GameMeta; chunks: Chunk[]; gameUpdate: GameAggregateUpdate };
type GameAggregateUpdate = {
  services: string[];
  summaryText: string;
  subniches: string[];
  mechanics: string[];
  scriptCount: number;
  qualityScore: number;
};

async function prepareGame(game: GameRow): Promise<PreparedGame> {
  const manifestRaw = await r2Get(`${game.r2Prefix}manifest.json`);
  if (!manifestRaw) throw new Error("manifest.json not in R2");
  const manifest: string[] = JSON.parse(manifestRaw);

  const rawFiles: { path: string; source: string }[] = [];
  for (const filePath of manifest) {
    const source = await r2Get(`${game.r2Prefix}${filePath}`);
    if (source) rawFiles.push({ path: filePath, source });
    await sleep(30);
  }
  if (!rawFiles.length) throw new Error("no script files in R2");

  const files = toScriptFiles(rawFiles);
  const localMeta = readLocalMeta(game.slug);
  const services = unique(files.flatMap((f) => f.services));
  const folders = unique(files.map((f) => folderName(f.filePath)));
  const subniches = normalizeSubniches(localMeta) ?? game.subniches ?? [];
  const inferredMechanics = inferMechanics(game.slug, services, folders);
  const mechanics = localMeta.mechanics ?? (game.mechanics?.length ? game.mechanics : inferredMechanics);
  const qualityScore = localMeta.qualityScore ?? localMeta.quality ?? game.qualityScore ?? 0.7;
  const meta: GameMeta = {
    slug: game.slug,
    name: game.name,
    niche: game.niche,
    subniches,
    mechanics,
    services,
    qualityScore,
  };
  const chunks = buildChunks(meta, files);
  const summaryText = buildSummaryText(meta, files);

  return {
    meta,
    chunks,
    gameUpdate: {
      services,
      summaryText,
      subniches,
      mechanics,
      scriptCount: files.length,
      qualityScore,
    },
  };
}

async function embedGame(game: GameRow): Promise<EmbedResult> {
  const { slug, id: gameId } = game;

  // ── Phase 0: fetch from R2 (read-only) ───────────────────────────────────

  let prepared: PreparedGame;
  try {
    prepared = await prepareGame(game);
  } catch (err) {
    return { slug, ok: false, chunks: 0, skipped: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const { meta, chunks: allChunks, gameUpdate } = prepared;
  const { niche, name } = meta;
  const indexName = `${indexPrefix}-${niche}`;

  // ── Phase 1: pure computation — build chunks, filter new, embed all ───────

  const existingIds = new Set(
    (await prisma.corpusChunk.findMany({
      where: { gameId, vectorizeId: { in: allChunks.map((c) => c.id) } },
      select: { vectorizeId: true },
    })).map((c) => c.vectorizeId),
  );

  const newChunks = allChunks.filter((c) => !existingIds.has(c.id));
  const skipped   = allChunks.length - newChunks.length;

  if (!newChunks.length) {
    if (!DRY_RUN) {
      await prisma.game.update({
        where: { id: gameId },
        data: { ingested: true, ingestedAt: new Date(), ...gameUpdate },
      });
    }
    return { slug, ok: true, chunks: 0, skipped };
  }
  if (DRY_RUN) return { slug, ok: true, chunks: newChunks.length, skipped };

  // Embed everything BEFORE writing anything (pure computation phase)
  const vectors: VectorRow[] = [];
  for (const chunk of newChunks) {
    const values = await embedText(chunk.embedText);
    vectors.push({
      id: chunk.id, values,
      metadata: { gameSlug: slug, gameName: name, niche, chunkType: chunk.type, r2Path: chunk.r2Path, robloxPath: chunk.robloxPath ?? "", qualityScore: chunk.qualityScore },
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
          lineStart: chunk.lineStart ?? null,
          lineEnd: chunk.lineEnd ?? null,
          symbols: chunk.symbols, remotes: chunk.remotes,
          services: chunk.services, requiredModules: chunk.requiredModules,
          tags: chunk.tags, qualityScore: chunk.qualityScore,
          sourceHash: chunk.sourceHash ?? null,
        })),
        skipDuplicates: true,
      });
      await tx.game.update({
        where: { id: gameId },
        data: { ingested: true, ingestedAt: new Date(), ...gameUpdate },
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

// ── Metadata backfill mode: Postgres only, no embeddings / Vectorize writes ──

type BackfillResult = {
  slug: string;
  ok: boolean;
  scriptUpdated: number;
  systemUpdated: number;
  summaryUpdated: number;
  missing: number;
  gameUpdated: boolean;
  error?: string;
};

function chunkUpdateData(chunk: Chunk) {
  return {
    r2Path: chunk.r2Path,
    title: chunk.title,
    systemName: chunk.systemName ?? null,
    filePath: chunk.filePath ?? null,
    robloxPath: chunk.robloxPath ?? null,
    scriptType: (chunk.scriptType as ScriptType | undefined) ?? null,
    lineStart: chunk.lineStart ?? null,
    lineEnd: chunk.lineEnd ?? null,
    symbols: chunk.symbols,
    requiredModules: chunk.requiredModules,
    remotes: chunk.remotes,
    services: chunk.services,
    tags: chunk.tags,
    qualityScore: chunk.qualityScore,
    sourceHash: chunk.sourceHash ?? null,
  };
}

async function backfillGame(game: GameRow): Promise<BackfillResult> {
  const empty: BackfillResult = {
    slug: game.slug,
    ok: false,
    scriptUpdated: 0,
    systemUpdated: 0,
    summaryUpdated: 0,
    missing: 0,
    gameUpdated: false,
  };

  try {
    const prepared = await prepareGame(game);
    const existing = await prisma.corpusChunk.findMany({
      where: { gameId: game.id, vectorizeId: { in: prepared.chunks.map((c) => c.id) } },
      select: { vectorizeId: true, r2Path: true },
    });
    const existingById = new Map(existing.map((row) => [row.vectorizeId, row]));
    const existingIds = new Set(existing.map((row) => row.vectorizeId));
    const missingChunks = prepared.chunks.filter((chunk) => !existingIds.has(chunk.id));
    const updateChunks = prepared.chunks.filter((chunk) => existingIds.has(chunk.id));

    for (const chunk of missingChunks) {
      console.warn(`  ⚠ ${game.slug}: missing Postgres chunk row for ${chunk.type} ${chunk.id} (${chunk.filePath ?? chunk.systemName ?? "summary"})`);
    }

    let r2Repairs = 0;
    if (!DRY_RUN) {
      for (const chunk of updateChunks) {
        const row = existingById.get(chunk.id);
        if (!row?.r2Path) continue;
        const existingContent = await r2Get(row.r2Path);
        if (existingContent === null) {
          await r2Put(row.r2Path, chunk.content);
          r2Repairs++;
        }
      }
    }

    if (DRY_RUN) {
      return {
        slug: game.slug,
        ok: true,
        scriptUpdated: updateChunks.filter((c) => c.type === "script").length,
        systemUpdated: updateChunks.filter((c) => c.type === "system").length,
        summaryUpdated: updateChunks.filter((c) => c.type === "summary").length,
        missing: missingChunks.length,
        gameUpdated: true,
      };
    }

    await prisma.$transaction(async (tx) => {
      for (const chunk of updateChunks) {
        await tx.corpusChunk.update({
          where: { vectorizeId: chunk.id },
          data: chunkUpdateData(chunk),
        });
      }
      await tx.game.update({
        where: { id: game.id },
        data: {
          ...prepared.gameUpdate,
          ingested: true,
          ingestedAt: new Date(),
        },
      });
    }, { timeout: Math.min(5000 + updateChunks.length * 300, 120_000), maxWait: 10_000 });

    if (r2Repairs) console.log(`  ↻ ${game.slug}: repaired ${r2Repairs} missing R2 chunk file(s) referenced by existing rows`);

    return {
      slug: game.slug,
      ok: true,
      scriptUpdated: updateChunks.filter((c) => c.type === "script").length,
      systemUpdated: updateChunks.filter((c) => c.type === "system").length,
      summaryUpdated: updateChunks.filter((c) => c.type === "summary").length,
      missing: missingChunks.length,
      gameUpdated: true,
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err),
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
  where: slugArg ? { slug: slugArg } : BACKFILL_METADATA ? {} : { ingested: false },
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
  console.log(slugArg ? `"${slugArg}" not found` : BACKFILL_METADATA ? "No games found to backfill" : "No un-ingested games — run sync-corpus.ts first");
  await pool.end();
  process.exit(0);
}

if (BACKFILL_METADATA) {
  console.log(`Backfilling metadata for ${games.length} game(s)${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  let done = 0, failed = 0, scriptUpdated = 0, systemUpdated = 0, summaryUpdated = 0, missing = 0, gameUpdated = 0;
  for (const game of games) {
    const r = await backfillGame(game as GameRow);
    if (r.ok) {
      console.log(`  ✓  ${r.slug}: scripts=${r.scriptUpdated}, systems=${r.systemUpdated}, summaries=${r.summaryUpdated}, missing=${r.missing}, game=${r.gameUpdated ? "updated" : "unchanged"}`);
      scriptUpdated += r.scriptUpdated;
      systemUpdated += r.systemUpdated;
      summaryUpdated += r.summaryUpdated;
      missing += r.missing;
      if (r.gameUpdated) gameUpdated++;
      done++;
    } else {
      console.log(`  ✗  ${r.slug}: ${r.error}`);
      failed++;
    }
  }

  await pool.end();
  console.log(`\n${done} games | ${scriptUpdated} script chunks | ${systemUpdated} system chunks | ${summaryUpdated} summary chunks | ${missing} missing rows | ${gameUpdated} game metadata updates | ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

console.log(`Embedding ${games.length} game(s)${DRY_RUN ? " (DRY RUN)" : ""}\n`);

let done = 0, failed = 0, totalChunks = 0, totalSkipped = 0;

for (const game of games) {
  const r = await embedGame(game as GameRow);
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
