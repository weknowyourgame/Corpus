/**
 * skip-broken-games.ts — find pending corpus games that can never embed because
 * their script files are missing from R2 (only manifest.json was uploaded, or the
 * manifest filenames are corrupted), and optionally mark them skipped in Postgres.
 *
 * Detection is cheap: one R2 "list objects" call per pending game. A game is broken
 * when there are ZERO .lua/.luau objects under its r2Prefix.
 *
 * Dry-run (default): reads only. Prints the broken list + counts, writes a report to
 *   .corpus/broken-games-report.json. Touches nothing.
 *
 * Apply: adds a `skipped` boolean column (idempotent) and sets skipped=true for the
 *   broken games so the embed scripts can exclude them.
 *
 * Usage:
 *   bun run scripts/skip-broken-games.ts                 # dry-run, scan all pending
 *   bun run scripts/skip-broken-games.ts --limit=50      # dry-run, first 50 pending
 *   bun run scripts/skip-broken-games.ts --apply         # mark broken games skipped
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// ── Args + env ────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = limitArg ? parseInt(limitArg) : Infinity;
const concArg = process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1];
const CONCURRENCY = concArg ? parseInt(concArg) : 8;

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
const apiToken = process.env.CLOUDFLARE_API_TOKEN!;
const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const databaseUrl = process.env.DATABASE_URL!;

if (!accountId || !apiToken || !databaseUrl) {
  console.error("Missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DATABASE_URL");
  process.exit(1);
}

const R2_LIST = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const R2_OBJ = R2_LIST; // same base; append /<key> for a single object
const H = { Authorization: `Bearer ${apiToken}` };
const encKey = (k: string) => k.split("/").map(encodeURIComponent).join("/");

const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    }),
  );
}

const isScriptKey = (k: string) => /\.luau?$/i.test(k);

/** List every object key under a prefix (paginated). */
async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const url = `${R2_LIST}?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: H });
    if (!res.ok) throw new Error(`R2 list ${prefix}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { result?: { key: string }[]; result_info?: { cursor?: string; is_truncated?: boolean } };
    for (const o of json.result ?? []) keys.push(o.key);
    cursor = json.result_info?.is_truncated ? json.result_info?.cursor : undefined;
  } while (cursor);
  return keys;
}

async function manifestLooksCorrupted(prefix: string): Promise<boolean> {
  const res = await fetch(`${R2_OBJ}/${encKey(prefix + "manifest.json")}`, { headers: H });
  if (!res.ok) return false;
  try {
    const entries = JSON.parse(await res.text()) as string[];
    // U+FFFD replacement chars or control bytes in paths = corrupted conversion
    return entries.some((e) => /[\uFFFD\u0000-\u001F]/.test(e));
  } catch {
    return true; // manifest not valid JSON
  }
}

type Broken = { slug: string; r2Prefix: string; totalObjects: number; scriptObjects: number; corruptManifest: boolean; reason: string };

// ── Main ──────────────────────────────────────────────────────────────────────

const pending = await prisma.game.findMany({
  where: { ingested: false },
  select: { slug: true, r2Prefix: true },
  orderBy: { createdAt: "asc" },
});
const scan = Number.isFinite(LIMIT) ? pending.slice(0, LIMIT) : pending;

console.log(`Pending games: ${pending.length}. Scanning ${scan.length} for missing script files in R2…\n`);

const broken: Broken[] = [];
const healthy: string[] = [];
let scanned = 0;

await runPool(scan, CONCURRENCY, async (g) => {
  try {
    const keys = await listKeys(g.r2Prefix);
    const scriptObjects = keys.filter(isScriptKey).length;
    if (scriptObjects === 0) {
      const corrupt = await manifestLooksCorrupted(g.r2Prefix);
      broken.push({
        slug: g.slug,
        r2Prefix: g.r2Prefix,
        totalObjects: keys.length,
        scriptObjects,
        corruptManifest: corrupt,
        reason: corrupt ? "no script files in R2 + corrupted manifest filenames" : "no script files in R2",
      });
    } else {
      healthy.push(g.slug);
    }
  } catch (err) {
    console.warn(`  ! ${g.slug}: scan error — ${err instanceof Error ? err.message : String(err)}`);
  }
  scanned++;
  if (scanned % 25 === 0 || scanned === scan.length) console.log(`  scanned ${scanned}/${scan.length}`);
});

broken.sort((a, b) => a.slug.localeCompare(b.slug));

console.log(`\n${"─".repeat(72)}`);
console.log(`BROKEN (unrecoverable, no scripts in R2): ${broken.length}`);
console.log(`HEALTHY (have script files, embeddable): ${healthy.length}`);
console.log(`${"─".repeat(72)}\n`);

for (const b of broken) {
  console.log(`  ✗  ${b.slug.padEnd(34)} objs=${String(b.totalObjects).padStart(4)} scripts=0  ${b.corruptManifest ? "[corrupt manifest]" : ""}`);
}

// Always write the audit report so there's a permanent record of what was found.
mkdirSync(".corpus", { recursive: true });
const reportPath = ".corpus/broken-games-report.json";
writeFileSync(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), scanned: scan.length, brokenCount: broken.length, broken }, null, 2),
);
console.log(`\nReport written: ${reportPath}`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing changed. Re-run with --apply to mark these ${broken.length} games skipped.`);
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}

if (broken.length === 0) {
  console.log("\nNothing to mark.");
} else {
  // Idempotent column add, then flag the broken games. Raw SQL so no client regen needed.
  await prisma.$executeRawUnsafe(`ALTER TABLE games ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false`);
  const slugs = broken.map((b) => b.slug);
  const updated = await prisma.$executeRawUnsafe(`UPDATE games SET skipped = true WHERE slug = ANY($1::text[])`, slugs);
  console.log(`\nAPPLIED — marked ${updated} games skipped=true.`);
  console.log("Next: update embed scripts' pending filter to exclude skipped (see chat).");
}

await prisma.$disconnect();
await pool.end();
