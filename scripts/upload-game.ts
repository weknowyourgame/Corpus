/**
 * Uploads a converted game to R2 and registers it in Postgres via the server API.
 * Run AFTER batch-convert.sh and generate-manifests.ts.
 *
 * Usage: bun run scripts/upload-game.ts <slug> <niche> [quality]
 * Example: bun run scripts/upload-game.ts flood-escape obby 0.8
 *
 * Niches: tower-defense | fps | obby | rpg | simulator | tycoon | battle-royale | horror | racing | social | general
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const slug = process.argv[2];
const niche = process.argv[3];
const quality = parseFloat(process.argv[4] ?? "0.7");

if (!slug || !niche) {
  console.error("Usage: bun run scripts/upload-game.ts <slug> <niche> [quality]");
  console.error("Niches: tower-defense | fps | obby | rpg | simulator | tycoon | battle-royale | horror | racing | social | general");
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const bridgeUrl = process.env.VITE_BRIDGE_URL ?? "http://localhost:3001";

if (!accountId || !apiToken) {
  console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

const CONVERTED_DIR = join(homedir(), "stud", "games", "converted");
const gameDir = join(CONVERTED_DIR, slug);
const rawDir = join(gameDir, "raw");
const manifestPath = join(gameDir, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error(`manifest.json not found at ${manifestPath}`);
  console.error("Run: bun run scripts/generate-manifests.ts first");
  process.exit(1);
}

const manifest: string[] = JSON.parse(readFileSync(manifestPath, "utf8"));
const r2Prefix = `${slug}/`;
const r2Base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;

async function putR2(key: string, body: string): Promise<void> {
  const res = await fetch(`${r2Base}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status}: ${await res.text()}`);
}

console.log(`\nUploading: ${slug} (${niche})`);
console.log(`Files: ${manifest.length} | Quality: ${quality} | Bucket: ${bucket}\n`);

// 1. Upload manifest.json
await putR2(`${r2Prefix}manifest.json`, readFileSync(manifestPath, "utf8"));
console.log(`✓ manifest.json`);

// 2. Upload each script file
let uploaded = 0;
let failed = 0;
const sourceBase = existsSync(rawDir) ? rawDir : gameDir;

for (const filePath of manifest) {
  const localPath = join(sourceBase, filePath.replace(/^raw\//, ""));
  if (!existsSync(localPath)) {
    console.warn(`  ⚠ missing: ${localPath}`);
    failed++;
    continue;
  }
  try {
    await putR2(`${r2Prefix}${filePath}`, readFileSync(localPath, "utf8"));
    uploaded++;
  } catch (err) {
    console.error(`  ✗ ${filePath}: ${err}`);
    failed++;
  }
}
console.log(`✓ ${uploaded} scripts uploaded${failed ? `, ${failed} failed` : ""}`);

// 3. Register game in Postgres via server API
const gameName = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
console.log(`\nRegistering in Postgres via ${bridgeUrl}/corpus/games...`);
const regRes = await fetch(`${bridgeUrl}/corpus/games`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ slug, name: gameName, niche, r2Prefix, qualityScore: quality }),
});

if (regRes.ok) {
  console.log(`✓ Registered: ${gameName}`);
} else {
  const err = await regRes.text();
  console.error(`✗ Registration failed: ${err}`);
  console.error(`  Manual SQL fallback:`);
  console.error(`  INSERT INTO games (slug, name, niche, r2_prefix, quality_score)`);
  console.error(`  VALUES ('${slug}', '${gameName}', '${niche}', '${r2Prefix}', ${quality});`);
}

console.log(`\nDone. Trigger ingestion when ready:`);
console.log(`  curl -X POST ${bridgeUrl}/corpus/ingest`);
