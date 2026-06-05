/**
 * sync-corpus.ts — Single source of truth: local ~/corpus/games/converted/
 *
 * For each local game, determines its state and acts accordingly:
 *   Neither in R2 nor Postgres  → upload ALL to R2, then insert Postgres
 *   In R2 but missing Postgres  → insert Postgres only (R2 already fine)
 *   In Postgres but missing R2  → re-upload to R2, update Postgres
 *   Both present                → skip
 *
 * ACID guarantee (best-effort with R2, which has no transactions):
 *   - Upload all files to R2 first, track every key uploaded
 *   - Only write to Postgres AFTER full R2 success
 *   - On ANY failure: delete every key we uploaded this run, skip Postgres
 *   - Postgres uses upsert — no duplicates possible
 *
 * Usage: bun run scripts/sync-corpus.ts [--concurrency=5] [--dry-run]
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// ── Config ────────────────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "5");
const DRY_RUN     = process.argv.includes("--dry-run");

const accountId   = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken    = process.env.CLOUDFLARE_API_TOKEN;
const bucket      = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const databaseUrl = process.env.DATABASE_URL;

if (!accountId || !apiToken) { console.error("✗ Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"); process.exit(1); }
if (!databaseUrl)            { console.error("✗ Missing DATABASE_URL"); process.exit(1); }

const R2 = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const pool   = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);
const CONVERTED = join(homedir(), "corpus", "games", "converted");

// ── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
  private q: (() => void)[] = [];
  private n = 0;
  constructor(private limit: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<void>((res) => {
      this.n < this.limit ? (this.n++, res()) : this.q.push(() => (this.n++, res()));
    }).then(() => fn()).finally(() => { this.n--; this.q.shift()?.(); });
  }
}

const sem   = new Semaphore(CONCURRENCY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Niche detection ───────────────────────────────────────────────────────────

const NICHES: Record<string, string[]> = {
  "tower-defense": ["tower", "defense", "defend", "td", "wave", "turret"],
  "fps":           ["fps", "gun", "shoot", "laser", "combat", "war", "military", "rifle"],
  "obby":          ["obby", "obstacle", "parkour", "flood", "escape", "course", "jump"],
  "rpg":           ["rpg", "quest", "adventure", "dungeon", "magic", "sword", "hero"],
  "simulator":     ["simulator", "sim", "pet", "mining", "farm", "click", "idle", "rebirth"],
  "tycoon":        ["tycoon", "factory", "dropper", "cashier", "business", "empire"],
  "battle-royale": ["battle", "royal", "survive", "zone", "shrink"],
  "horror":        ["horror", "scary", "flee", "jumpscare", "haunted", "backroom"],
  "racing":        ["racing", "race", "car", "kart", "drive", "speed", "vehicle"],
  "social":        ["social", "hangout", "roleplay", "rp", "life", "city", "town"],
};

const detectNiche = (slug: string): string => {
  const lower = slug.toLowerCase();
  let best = "general", top = 0;
  for (const [niche, kws] of Object.entries(NICHES)) {
    const s = kws.filter((k) => lower.includes(k)).length;
    if (s > top) { top = s; best = niche; }
  }
  return best;
};

// ── R2 helpers ────────────────────────────────────────────────────────────────

const encKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

async function r2Exists(key: string): Promise<boolean> {
  const res = await fetch(`${R2}/${encKey(key)}`, { headers: { Authorization: `Bearer ${apiToken}` } });
  return res.ok;
}

async function r2Put(key: string, body: string, retries = 4): Promise<void> {
  let last = "";
  for (let i = 1; i <= retries; i++) {
    const res = await fetch(`${R2}/${encKey(key)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain; charset=utf-8" },
      body,
    });
    if (res.ok) return;
    last = `${res.status}: ${await res.text()}`;
    if (res.status === 429 || res.status >= 500) { await sleep(300 * i); continue; }
    throw new Error(last);
  }
  throw new Error(`R2 upload failed after ${retries} retries — ${last}`);
}

async function r2Delete(key: string): Promise<void> {
  await fetch(`${R2}/${encKey(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
}

// ── Per-game sync ─────────────────────────────────────────────────────────────

type GameState = "both" | "r2-only" | "db-only" | "neither";
type SyncResult = { slug: string; state: GameState; action: string; ok: boolean; error?: string };

async function syncGame(slug: string): Promise<SyncResult> {
  const gameDir      = join(CONVERTED, slug);
  const manifestPath = join(gameDir, "manifest.json");
  const rawDir       = join(gameDir, "raw");
  const metaPath     = join(gameDir, "meta.json");

  if (!existsSync(manifestPath)) {
    return { slug, state: "neither", action: "skip", ok: false, error: "no local manifest.json" };
  }

  const manifest: string[] = JSON.parse(readFileSync(manifestPath, "utf8"));
  const meta    = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const niche   = meta.niche   ?? detectNiche(slug);
  const name    = meta.name    ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const quality = meta.quality ?? 0.7;
  const prefix  = `${slug}/`;
  const sourceBase = existsSync(rawDir) ? rawDir : gameDir;

  // ── Determine state ──────────────────────────────────────────────────────

  const [hasR2, hasDb] = await Promise.all([
    r2Exists(`${prefix}manifest.json`),
    prisma.game.findUnique({ where: { slug } }).then(Boolean).catch(() => false),
  ]);

  const state: GameState = hasR2 && hasDb ? "both"
    : hasR2 && !hasDb ? "r2-only"
    : !hasR2 && hasDb ? "db-only"
    : "neither";

  if (state === "both") {
    return { slug, state, action: "skip", ok: true };
  }

  if (DRY_RUN) {
    const action = state === "r2-only" ? "would insert Postgres"
      : state === "db-only" ? "would re-upload R2"
      : "would upload R2 + insert Postgres";
    return { slug, state, action, ok: true };
  }

  // ── Act based on state ───────────────────────────────────────────────────

  const uploadedKeys: string[] = [];

  try {
    if (state === "neither" || state === "db-only") {
      // Upload every file to R2 — track keys for rollback
      const files = [`manifest.json`, ...manifest];
      for (const filePath of files) {
        const isManifest = filePath === "manifest.json";
        const local = isManifest ? manifestPath : join(sourceBase, filePath.replace(/^raw\//, ""));
        if (!existsSync(local)) continue;
        const key = `${prefix}${filePath}`;
        await sem.run(() => r2Put(key, readFileSync(local, "utf8")));
        uploadedKeys.push(key);
        await sleep(50);
      }
    }

    // Write to Postgres only after R2 is fully done
    await prisma.game.upsert({
      where:  { slug },
      update: { name, niche, r2Prefix: prefix, qualityScore: quality, scriptCount: manifest.length },
      create: { slug, name, niche, r2Prefix: prefix, qualityScore: quality, scriptCount: manifest.length, ingested: false },
    });

    const action = state === "r2-only" ? "inserted Postgres"
      : state === "db-only" ? "re-uploaded R2 + updated Postgres"
      : "uploaded R2 + inserted Postgres";

    return { slug, state, action, ok: true };

  } catch (err) {
    // Rollback: delete everything we uploaded this run
    if (uploadedKeys.length) {
      await Promise.allSettled(uploadedKeys.map(r2Delete));
    }
    return {
      slug, state, action: "failed + rolled back R2", ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const games = readdirSync(CONVERTED).filter((d) =>
  statSync(join(CONVERTED, d)).isDirectory() &&
  existsSync(join(CONVERTED, d, "manifest.json")),
);

if (!games.length) {
  console.log(`No local games found in ${CONVERTED}`);
  process.exit(0);
}

console.log(`Syncing ${games.length} games | concurrency=${CONCURRENCY}${DRY_RUN ? " | DRY RUN" : ""}\n`);

const results = await Promise.all(games.map(syncGame));

const counts = { skip: 0, done: 0, fail: 0 };
for (const r of results) {
  if (!r.ok)           { console.log(`  ✗  ${r.slug}: ${r.error}`); counts.fail++; }
  else if (r.action === "skip") { counts.skip++; }
  else                 { console.log(`  ✓  [${r.state}] ${r.slug} → ${r.action}`); counts.done++; }
}

await pool.end();

console.log(`\n${counts.done} synced | ${counts.skip} already done | ${counts.fail} failed`);
if (counts.fail > 0) console.log("Failed games were rolled back — safe to retry.");
if (counts.done > 0) console.log(`\nTrigger ingestion: curl -X POST http://localhost:3001/corpus/ingest`);
