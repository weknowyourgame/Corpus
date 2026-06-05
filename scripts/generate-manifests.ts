/**
 * For each converted game folder in ~/corpus/games/converted/:
 *   1. Walks all .lua/.luau files and writes manifest.json
 *   2. Prints the SQL INSERT needed to register the game in Postgres
 *
 * Usage: bun run scripts/generate-manifests.ts
 */

import { readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";

const CONVERTED_DIR = join(homedir(), "corpus", "games", "converted");

const NICHES = [
  "tower-defense", "fps", "obby", "rpg", "simulator",
  "tycoon", "battle-royale", "horror", "racing", "social", "general",
];

function walkLua(dir: string, base: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    if (statSync(full).isDirectory()) {
      walkLua(full, base, results);
    } else if ([".lua", ".luau"].includes(extname(entry))) {
      results.push("raw/" + rel);
    }
  }
  return results;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const games = readdirSync(CONVERTED_DIR).filter((d) =>
  statSync(join(CONVERTED_DIR, d)).isDirectory(),
);

if (!games.length) {
  console.log(`No converted game folders found in ${CONVERTED_DIR}`);
  process.exit(0);
}

console.log(`Found ${games.length} game(s)\n`);
console.log("=".repeat(60));

for (const gameName of games) {
  const gameDir = join(CONVERTED_DIR, gameName);
  const rawDir = join(gameDir, "raw");

  const sourceDir = existsSync(rawDir) ? rawDir : gameDir;
  const manifestBase = existsSync(rawDir) ? gameDir : gameDir;

  const luaFiles = walkLua(sourceDir, sourceDir);

  if (!luaFiles.length) {
    console.log(`\n⚠ ${gameName}: no .lua/.luau files found — skipping`);
    continue;
  }

  // Adjust paths: prefix with raw/ only if not already under raw/
  const manifest = luaFiles.map((f) =>
    existsSync(rawDir) ? f : `raw/${f.replace(/^raw\//, "")}`,
  );

  writeFileSync(join(gameDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const slug = slugify(gameName);
  const r2Prefix = `${slug}/`;

  console.log(`\n✓ ${gameName}`);
  console.log(`  slug:     ${slug}`);
  console.log(`  scripts:  ${luaFiles.length}`);
  console.log(`  manifest: ${join(gameDir, "manifest.json")}`);
  console.log(`\n  Postgres INSERT (fill in niche from: ${NICHES.join(", ")}):`);
  console.log(`
  INSERT INTO games (slug, name, niche, r2_prefix, quality_score)
  VALUES ('${slug}', '${gameName}', '<niche>', '${r2Prefix}', 0.7);
  `);
  console.log(`  R2 upload commands:`);
  console.log(`    # Upload manifest`);
  console.log(`    curl -X PUT https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$CLOUDFLARE_R2_BUCKET/objects/${r2Prefix}manifest.json \\`);
  console.log(`      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data-binary @${join(gameDir, "manifest.json")}`);
  console.log(`    # Upload scripts (repeat for each file)`);
  console.log(`    # See: bun run scripts/upload-game.ts ${slug}`);
}

console.log("\n" + "=".repeat(60));
console.log("\nNext step: run bun run scripts/upload-game.ts <slug> for each game");
