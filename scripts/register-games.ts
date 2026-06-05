/**
 * Registers all converted games into Postgres without re-uploading to R2.
 * Run this when R2 already has the files but Postgres is empty.
 *
 * Usage: bun run scripts/register-games.ts
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const accountId   = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken    = process.env.CLOUDFLARE_API_TOKEN;
const bucket      = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";

if (!databaseUrl) { console.error("Missing DATABASE_URL"); process.exit(1); }
if (!accountId || !apiToken) { console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"); process.exit(1); }

const R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const r2Key   = (key: string) => key.split("/").map(encodeURIComponent).join("/");

async function existsInR2(key: string): Promise<boolean> {
  const res = await fetch(`${R2_BASE}/${r2Key(key)}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  return res.ok;
}

const pool   = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);

const CONVERTED = join(homedir(), "corpus", "games", "converted");

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

const games = readdirSync(CONVERTED).filter((d) =>
  statSync(join(CONVERTED, d)).isDirectory() &&
  existsSync(join(CONVERTED, d, "manifest.json")),
);

console.log(`Registering ${games.length} games into Postgres...\n`);

let done = 0, failed = 0;

for (const slug of games) {
  const gameDir      = join(CONVERTED, slug);
  const manifestPath = join(gameDir, "manifest.json");
  const metaPath     = join(gameDir, "meta.json");
  const meta         = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const manifest: string[] = JSON.parse(readFileSync(manifestPath, "utf8"));

  const niche    = meta.niche   ?? detectNiche(slug);
  const name     = meta.name    ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const quality  = meta.quality ?? 0.7;
  const r2Prefix = `${slug}/`;

  try {
    const inR2 = await existsInR2(`${r2Prefix}manifest.json`);
    if (!inR2) {
      console.log(`  ⟳  ${slug}: not in R2, skipping`);
      continue;
    }

    await prisma.game.upsert({
      where: { slug },
      update: { name, niche, r2Prefix, qualityScore: quality, scriptCount: manifest.length },
      create: { slug, name, niche, r2Prefix, qualityScore: quality, scriptCount: manifest.length, ingested: false },
    });
    console.log(`  ✓  ${slug} → ${niche} (${manifest.length} scripts)`);
    done++;
  } catch (err) {
    console.error(`  ✗  ${slug}: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

await pool.end();
console.log(`\nDone: ${done} registered, ${failed} failed`);
if (done > 0) console.log(`\nTrigger ingestion: curl -X POST http://localhost:3001/corpus/ingest`);
