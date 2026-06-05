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
const MAX_ATTEMPTS  = 3;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = MAX_ATTEMPTS): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt === attempts) break;
      const waitMs = 2_500 * attempt;
      console.warn(`    ${label} failed (attempt ${attempt}/${attempts}); retrying in ${fmtDuration(waitMs)}`);
      await sleep(waitMs);
    }
  }
  throw last;
}

function isTransientFailure(output: string): boolean {
  return /Failed to connect to upstream database|ECONNRESET|ETIMEDOUT|timeout|fetch failed|429|5\d\d/.test(output);
}

function summarizeFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !line.includes("SECURITY WARNING: The SSL modes"))
    .filter((line) => !line.includes("In the next major version"))
    .filter((line) => !line.includes("To prepare for this change"))
    .filter((line) => !line.includes("See https://www.postgresql.org/docs/current/libpq-ssl.html"))
    .filter((line) => !line.includes("Use `node --trace-warnings ...`"));
  return lines.slice(-8).join("\n");
}

async function getPendingGames(): Promise<{ slug: string }[]> {
  const all = await withRetry("pending game query", () => prisma.game.findMany({
    where: { ingested: false },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  }));

  if (!startAfterArg) return all.slice(0, LIMIT);

  const idx = all.findIndex((g) => g.slug === startAfterArg);
  if (idx === -1) {
    console.warn(`Warning: --start-after slug "${startAfterArg}" not found in pending games; starting from the beginning`);
    return all.slice(0, LIMIT);
  }
  return all.slice(idx + 1, idx + 1 + LIMIT);
}

async function getCorpusCounts(): Promise<{ total: number; ingested: number; pending: number; chunks: number }> {
  const [total, ingested, chunks] = await withRetry("corpus count query", () => Promise.all([
    prisma.game.count(),
    prisma.game.count({ where: { ingested: true } }),
    prisma.corpusChunk.count(),
  ]));
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

async function runEmbedForSlugWithRetry(slug: string): Promise<{ ok: boolean; output: string; attempts: number }> {
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await runEmbedForSlug(slug);
    if (result.ok) return { ...result, attempts: attempt };
    last = result.output;
    if (!isTransientFailure(result.output) || attempt === MAX_ATTEMPTS) {
      return { ...result, attempts: attempt };
    }
    const waitMs = 5_000 * attempt;
    process.stdout.write(`retrying transient failure in ${fmtDuration(waitMs)} … `);
    await sleep(waitMs);
  }
  return { ok: false, output: last, attempts: MAX_ATTEMPTS };
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

  const { ok, output, attempts } = await runEmbedForSlugWithRetry(slug);
  const elapsed = Date.now() - start;

  if (ok) {
    console.log(`✓ ${fmtDuration(elapsed)}${attempts > 1 ? ` (${attempts} attempts)` : ""}`);
    succeeded.push(slug);
  } else {
    console.log(`✗ ${fmtDuration(elapsed)}${attempts > 1 ? ` (${attempts} attempts)` : ""}`);
    const summary = summarizeFailure(output);
    if (summary) console.log(`    ${summary.split("\n").join("\n    ")}`);
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
