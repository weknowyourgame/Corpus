/**
 * Uploads ALL converted games to R2 and registers them in Postgres.
 * Auto-detects niche from game name — override per-game with a meta.json.
 *
 * Usage: bun run scripts/upload-all.ts [options]
 *
 * Options:
 *   --concurrency=5    Max simultaneous R2 upload requests       (default 5)
 *   --delay=100        ms between individual file uploads        (default 100)
 *   --quality=0.7      Default quality score stored in Postgres  (default 0.7)
 *
 * Quality score (0.0–1.0): controls retrieval ranking — higher-quality
 * chunks surface first in the AI's context. Set per-game in meta.json.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const arg = (prefix: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(prefix))?.split("=")[1] ?? fallback;

const CONCURRENCY = parseInt(arg("--concurrency=", "5"));
const DELAY_MS    = parseInt(arg("--delay=", "100"));
const QUALITY     = parseFloat(arg("--quality=", "0.7"));

const accountId   = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken    = process.env.CLOUDFLARE_API_TOKEN;
const bucket      = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const databaseUrl = process.env.DATABASE_URL;

if (!accountId || !apiToken) {
  console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in env");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("Missing DATABASE_URL in env");
  process.exit(1);
}

const pool    = new pg.Pool({ connectionString: databaseUrl });
const prisma  = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);

const CONVERTED = join(homedir(), "stud", "games", "converted");
const R2_BASE   = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;

// ── Semaphore — caps concurrent in-flight requests ────────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (this.running < this.limit) { this.running++; resolve(); }
      else this.queue.push(() => { this.running++; resolve(); });
    });
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

const sem = new Semaphore(CONCURRENCY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Niche auto-detection ──────────────────────────────────────────────────────

const NICHE_KEYWORDS: Record<string, string[]> = {
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

function detectNiche(slug: string): string {
  const lower = slug.toLowerCase();
  let best = "general", bestScore = 0;
  for (const [niche, kws] of Object.entries(NICHE_KEYWORDS)) {
    const score = kws.filter((k) => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = niche; }
  }
  return best;
}

// ── R2 single-file upload with retry ─────────────────────────────────────────

// Encode each path segment but preserve slashes for R2
const r2Key = (key: string) => key.split("/").map(encodeURIComponent).join("/");

async function putR2(key: string, body: string, retries = 3): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${R2_BASE}/${r2Key(key)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain; charset=utf-8" },
      body,
    });
    if (res.ok) return;
    lastError = `${res.status}: ${await res.text()}`;
    if (res.status === 429 || res.status >= 500) {
      await sleep(DELAY_MS * attempt * 3);
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(`Failed after ${retries} retries — last error: ${lastError}`);
}

// ── Per-game upload ───────────────────────────────────────────────────────────

type Result = { slug: string; ok: boolean; scripts: number; error?: string };

async function isAlreadyUploaded(slug: string): Promise<boolean> {
  const existing = await prisma.game.findUnique({ where: { slug } }).catch(() => null);
  return existing !== null;
}

async function uploadGame(slug: string): Promise<Result> {
  const gameDir      = join(CONVERTED, slug);
  const manifestPath = join(gameDir, "manifest.json");
  const rawDir       = join(gameDir, "raw");

  if (!existsSync(manifestPath)) return { slug, ok: false, scripts: 0, error: "no manifest.json" };

  // Skip if already on R2
  if (await isAlreadyUploaded(slug)) return { slug, ok: true, scripts: 0, error: "skipped (already uploaded)" };

  const manifest: string[] = JSON.parse(readFileSync(manifestPath, "utf8"));
  const r2Prefix = `${slug}/`;

  const metaPath = join(gameDir, "meta.json");
  const meta     = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const niche    = meta.niche   ?? detectNiche(slug);
  const name     = meta.name    ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const quality  = meta.quality ?? QUALITY;

  try {
    const sourceBase = existsSync(rawDir) ? rawDir : gameDir;

    // Upload manifest + all scripts through the semaphore with delay between each
    const files = [`manifest.json`, ...manifest];
    for (const filePath of files) {
      const isManifest = filePath === "manifest.json";
      const local = isManifest ? manifestPath : join(sourceBase, filePath.replace(/^raw\//, ""));
      if (!existsSync(local)) continue;

      await sem.run(() => putR2(`${r2Prefix}${filePath}`, readFileSync(local, "utf8")));
      await sleep(DELAY_MS);
    }

    // Register directly in Postgres
    await prisma.game.upsert({
      where: { slug },
      update: { name, niche, r2Prefix, qualityScore: quality },
      create: { slug, name, niche, r2Prefix, qualityScore: quality, ingested: false },
    });

    return { slug, ok: true, scripts: manifest.length };
  } catch (err) {
    return { slug, ok: false, scripts: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const games = readdirSync(CONVERTED).filter((d) =>
  statSync(join(CONVERTED, d)).isDirectory() &&
  existsSync(join(CONVERTED, d, "manifest.json")),
);

if (!games.length) {
  console.log(`No converted games in ${CONVERTED} — run batch-convert.ts first`);
  process.exit(0);
}

console.log(`Uploading ${games.length} games | concurrency=${CONCURRENCY} | delay=${DELAY_MS}ms | quality=${QUALITY}\n`);

// Run all games concurrently through the semaphore (it handles the throttling)
const results = await Promise.all(games.map(uploadGame));

let done = 0, failed = 0, totalScripts = 0;
for (const r of results) {
  if (r.ok && r.scripts === 0) {
    console.log(`  ⟳  ${r.slug} (skipped)`);
  } else if (r.ok) {
    console.log(`  ✓  ${r.slug} (${r.scripts} scripts)`);
    done++;
    totalScripts += r.scripts;
  } else {
    console.log(`  ✗  ${r.slug}: ${r.error}`);
    failed++;
  }
}

console.log(`\nDone: ${done} uploaded (${totalScripts} total scripts), ${failed} failed`);
if (done > 0) console.log(`\nTrigger ingestion: curl -X POST http://localhost:3001/corpus/ingest`);

await pool.end();
