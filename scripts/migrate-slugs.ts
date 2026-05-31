/**
 * migrate-slugs.ts — Converts raw game names to URL-safe slugs in Postgres.
 *
 * R2 object keys and r2Prefix are NEVER touched. Only the slug column changes.
 * Safe to run multiple times (idempotent — already-clean slugs are skipped).
 *
 * Usage:
 *   bun run scripts/migrate-slugs.ts --dry-run   # preview only
 *   bun run scripts/migrate-slugs.ts --apply     # write to DB inside a transaction
 */

import { createHash } from "node:crypto";
import pg from "pg";

const DRY_RUN = !process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;

// ── Slugify ───────────────────────────────────────────────────────────────────

export function slugify(raw: string): string {
  return raw
    .normalize("NFD")                        // decompose unicode accents
    .replace(/[̀-ͯ]/g, "")         // strip accent marks
    .toLowerCase()
    .trim()
    .replace(/[\[\](){}]/g, " ")             // brackets → space
    .replace(/[''`´]/g, "")                  // apostrophes → nothing
    .replace(/[&+]/g, " and ")              // & → and
    .replace(/[^a-z0-9\s-]/g, " ")          // everything else non-alnum → space
    .replace(/[\s_-]+/g, "-")               // collapse whitespace/dashes
    .replace(/^-+|-+$/g, "")               // strip leading/trailing dashes
    || "game";                               // fallback if result is empty
}

// Deterministic suffix to resolve collisions — same input always gives same output
function dedupe(slug: string, taken: Set<string>, original: string): string {
  if (!taken.has(slug)) return slug;
  const suffix = createHash("sha256").update(original).digest("hex").slice(0, 6);
  const withSuffix = `${slug}-${suffix}`;
  if (!taken.has(withSuffix)) return withSuffix;
  // Extremely rare: suffix also collides, fall back to counter
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// ── Main (only runs when executed directly, not when imported by tests) ───────

if (!import.meta.main) { /* imported as module — stop here */ }
else {

if (!databaseUrl) { console.error("Missing DATABASE_URL"); process.exit(1); }

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

type GameRow = { id: string; slug: string; r2_prefix: string };

const { rows } = await client.query<GameRow>(
  "SELECT id, slug, r2_prefix FROM games ORDER BY created_at ASC",
);

console.log(`\nFound ${rows.length} games\n`);

// Build migration plan
type Plan = { id: string; oldSlug: string; newSlug: string; r2Prefix: string; changed: boolean };

const taken = new Set<string>();  // final slugs already assigned this run
const existingClean = new Set<string>(); // slugs already URL-safe (to avoid re-colliding with them)

// First pass: collect all slugs that are already clean so we don't collide with them
for (const row of rows) {
  const clean = slugify(row.slug);
  if (clean === row.slug) existingClean.add(row.slug);
}
for (const slug of existingClean) taken.add(slug);

const plan: Plan[] = [];

for (const row of rows) {
  const newSlug = slugify(row.slug);
  if (newSlug === row.slug) {
    // Already clean — no change needed, just reserve the slug
    taken.add(row.slug);
    plan.push({ id: row.id, oldSlug: row.slug, newSlug: row.slug, r2Prefix: row.r2_prefix, changed: false });
    continue;
  }
  const final = dedupe(newSlug, taken, row.slug);
  taken.add(final);
  plan.push({ id: row.id, oldSlug: row.slug, newSlug: final, r2Prefix: row.r2_prefix, changed: true });
}

// ── Preview ───────────────────────────────────────────────────────────────────

const changes = plan.filter((p) => p.changed);
const unchanged = plan.filter((p) => !p.changed);

console.log(`Will update : ${changes.length} slugs`);
console.log(`Already clean: ${unchanged.length} slugs`);
console.log(`\n${"─".repeat(80)}`);
console.log(`${"OLD SLUG".padEnd(45)} → NEW SLUG`);
console.log("─".repeat(80));

for (const p of changes) {
  const collision = p.newSlug !== slugify(p.oldSlug) ? " ⚠ collision resolved" : "";
  console.log(`${p.oldSlug.slice(0, 44).padEnd(45)} → ${p.newSlug}${collision}`);
}

// ── Collision report ──────────────────────────────────────────────────────────

const collisions = changes.filter((p) => p.newSlug !== slugify(p.oldSlug));
if (collisions.length) {
  console.log(`\n⚠  ${collisions.length} collision(s) resolved with deterministic suffix:`);
  for (const c of collisions) {
    console.log(`   "${c.oldSlug}" → wanted "${slugify(c.oldSlug)}" → resolved to "${c.newSlug}"`);
  }
}

// ── Validate plan ─────────────────────────────────────────────────────────────

const finalSlugs = plan.map((p) => p.newSlug);
const dupes = finalSlugs.filter((s, i) => finalSlugs.indexOf(s) !== i);
if (dupes.length) {
  console.error(`\n✗ BUG: duplicate slugs in plan: ${[...new Set(dupes)].join(", ")}`);
  await client.end();
  process.exit(1);
}
console.log(`\n✓ Plan validated — no duplicate slugs`);

if (DRY_RUN) {
  console.log(`\n[DRY RUN] No changes written. Run with --apply to execute.\n`);
  await client.end();
  process.exit(0);
}

if (!changes.length) {
  console.log(`\nAll slugs already clean. Nothing to do.\n`);
  await client.end();
  process.exit(0);
}

// ── Apply inside a transaction ────────────────────────────────────────────────

console.log(`\nApplying ${changes.length} updates inside a transaction...`);

await client.query("BEGIN");

try {
  // Temporarily disable unique constraint enforcement to allow slug swaps
  // (two games swapping slugs would violate uniqueness mid-batch otherwise)
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  let updated = 0;
  for (const p of changes) {
    await client.query(
      "UPDATE games SET slug = $1 WHERE id = $2 AND slug = $3",
      [p.newSlug, p.id, p.oldSlug],
    );
    updated++;
    if (updated % 50 === 0) console.log(`  ... ${updated}/${changes.length}`);
  }

  // ── Post-migration validation (inside transaction, before commit) ──────────

  const { rows: postRows } = await client.query<{ slug: string; cnt: string }>(
    "SELECT slug, COUNT(*) as cnt FROM games GROUP BY slug HAVING COUNT(*) > 1",
  );
  if (postRows.length) {
    throw new Error(`Duplicate slugs after migration: ${postRows.map((r) => r.slug).join(", ")}`);
  }

  const { rows: nullRows } = await client.query(
    "SELECT COUNT(*) as cnt FROM games WHERE slug IS NULL OR slug = ''",
  );
  if (parseInt(nullRows[0].cnt) > 0) {
    throw new Error(`${nullRows[0].cnt} null/empty slugs after migration`);
  }

  await client.query("COMMIT");

  console.log(`\n✓ Migration complete — ${updated} slugs updated`);
  console.log(`✓ Validation passed — no duplicates, no nulls`);
  console.log(`\nR2 prefixes untouched. Rollback if needed:\n`);
  console.log(`  -- Rollback SQL (save this):`);
  for (const p of changes.slice(0, 5)) {
    console.log(`  UPDATE games SET slug = '${p.oldSlug.replace(/'/g, "''")}' WHERE slug = '${p.newSlug}';`);
  }
  if (changes.length > 5) console.log(`  -- ... and ${changes.length - 5} more`);

} catch (err) {
  await client.query("ROLLBACK");
  console.error(`\n✗ Migration failed — rolled back. DB unchanged.`);
  console.error(err instanceof Error ? err.message : err);
  await client.end();
  process.exit(1);
}

await client.end();

} // end import.meta.main
