/**
 * embed-pending-batches.ts — Resume helper for corpus embedding.
 *
 * Queries Postgres for un-ingested games and runs embed-games.ts --slug=<slug>
 * one at a time. Continues past individual failures; prints a final summary.
 *
 * Usage:
 *   bun run scripts/embed-pending-batches.ts
 *   bun run scripts/embed-pending-batches.ts --limit=10
 *   bun run scripts/embed-pending-batches.ts --start-after=flood-escape
 *   bun run scripts/embed-pending-batches.ts --limit=3 --dry-run
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// ── Args ──────────────────────────────────────────────────────────────────────

const limitArg      = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const startAfterArg = process.argv.find((a) => a.startsWith("--start-after="))?.split("=")[1];
const DRY_RUN       = process.argv.includes("--dry-run");
const LIMIT         = limitArg ? parseInt(limitArg) : 25;

const databaseUrl = process.env.DATABASE_URL!;
if (!databaseUrl) {
  console.error("Missing: DATABASE_URL");
  process.exit(1);
}

const pool   = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

async function getPendingGames(): Promise<{ slug: string }[]> {
  const all = await prisma.game.findMany({
    where: { ingested: false },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });

  if (!startAfterArg) return all.slice(0, LIMIT);

  const idx = all.findIndex((g) => g.slug === startAfterArg);
  if (idx === -1) {
    console.warn(`Warning: --start-after slug "${startAfterArg}" not found in pending games; starting from the beginning`);
    return all.slice(0, LIMIT);
  }
  return all.slice(idx + 1, idx + 1 + LIMIT);
}

async function getCorpusCounts(): Promise<{ total: number; ingested: number; pending: number; chunks: number }> {
  const [total, ingested, chunks] = await Promise.all([
    prisma.game.count(),
    prisma.game.count({ where: { ingested: true } }),
    prisma.corpusChunk.count(),
  ]);
  return { total, ingested, pending: total - ingested, chunks };
}

async function runEmbedForSlug(slug: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(
    ["bun", "run", "scripts/embed-games.ts", `--slug=${slug}`],
    { stdout: "pipe", stderr: "pipe", cwd: process.cwd() },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  return { ok: exitCode === 0, output };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pending = await getPendingGames();

if (!pending.length) {
  const counts = await getCorpusCounts();
  console.log(`No pending games found (total=${counts.total}, ingested=${counts.ingested}, pending=${counts.pending}, chunks=${counts.chunks})`);
  await pool.end();
  process.exit(0);
}

const startMsg = [
  `Processing ${pending.length} pending game(s)`,
  startAfterArg ? ` after "${startAfterArg}"` : "",
  DRY_RUN ? " (DRY RUN)" : "",
].join("") + "\n";

console.log(startMsg);

if (DRY_RUN) {
  for (const g of pending) console.log(`  would embed: ${g.slug}`);
  const counts = await getCorpusCounts();
  console.log(`\nCorpus status: total=${counts.total}, ingested=${counts.ingested}, pending=${counts.pending}, chunks=${counts.chunks}`);
  await pool.end();
  process.exit(0);
}

const succeeded: string[] = [];
const failed: string[]    = [];

for (const { slug } of pending) {
  const start = Date.now();
  process.stdout.write(`  ${slug} … `);

  const { ok, output } = await runEmbedForSlug(slug);
  const elapsed = Date.now() - start;

  if (ok) {
    console.log(`✓ ${fmtDuration(elapsed)}`);
    succeeded.push(slug);
  } else {
    console.log(`✗ ${fmtDuration(elapsed)}`);
    if (output) console.log(`    ${output.split("\n").slice(0, 3).join("\n    ")}`);
    failed.push(slug);
  }
}

// ── Final counts ──────────────────────────────────────────────────────────────

const counts = await getCorpusCounts();
console.log(`\nCorpus status: total=${counts.total}, ingested=${counts.ingested}, pending=${counts.pending}, chunks=${counts.chunks}`);
console.log(`Batch result: ${succeeded.length} succeeded, ${failed.length} failed`);

if (failed.length) {
  console.log(`\nFailed slugs (safe to retry with --slug):`);
  for (const s of failed) console.log(`  bun run scripts/embed-games.ts --slug=${s}`);
}

await pool.end();
process.exit(failed.length > 0 ? 1 : 0);
