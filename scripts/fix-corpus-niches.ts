/**
 * fix-corpus-niches.ts — bulk repair corpus niche labels and moved vectors.
 *
 * Default is dry-run. Use --apply to update Postgres/local meta.json.
 * Use --reembed with --apply to cleanup and re-embed already-ingested games
 * whose niche changed, so vectors move out of the old Vectorize index.
 *
 * Usage:
 *   bun run scripts/fix-corpus-niches.ts
 *   bun run scripts/fix-corpus-niches.ts --apply
 *   bun run scripts/fix-corpus-niches.ts --apply --reembed
 *   bun run scripts/fix-corpus-niches.ts --apply --only-general --reembed
 *   bun run scripts/fix-corpus-niches.ts --repair-stale-indexes --reembed
 *   bun run scripts/fix-corpus-niches.ts --repair-missing-raw --apply
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

type Niche =
  | "tower-defense"
  | "fps"
  | "obby"
  | "rpg"
  | "simulator"
  | "tycoon"
  | "battle-royale"
  | "horror"
  | "racing"
  | "social"
  | "general";

type GameRow = {
  id: string;
  slug: string;
  name: string;
  niche: string;
  ingested: boolean;
  scriptCount: number;
};

type LocalGame = {
  dir: string;
  manifest: string[];
  metaPath: string;
  meta: Record<string, unknown>;
};

type Classification = {
  niche: Niche;
  confidence: number;
  reasons: string[];
  subniches: string[];
  mechanics: string[];
};

const APPLY = process.argv.includes("--apply");
const REEMBED = process.argv.includes("--reembed");
const ONLY_GENERAL = process.argv.includes("--only-general");
const REPAIR_STALE_INDEXES = process.argv.includes("--repair-stale-indexes");
const REPAIR_MISSING_RAW = process.argv.includes("--repair-missing-raw");
const LIMIT = Number.parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10);
const MIN_CONFIDENCE = Number.parseInt(process.argv.find((a) => a.startsWith("--min-confidence="))?.split("=")[1] ?? "3", 10);
const indexPrefix = process.env.CLOUDFLARE_NICHE_INDEX_PREFIX ?? "roblox";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? "roblox-games";
const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);
const CONVERTED = join(homedir(), "stud", "games", "converted");
const R2 = accountId ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects` : "";

const slugify = (text: string) => text
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const unique = (values: string[], limit = Infinity): string[] => [...new Set(values.filter(Boolean))].slice(0, limit);
const encKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

async function r2Exists(key: string): Promise<boolean> {
  if (!R2 || !apiToken) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${R2}/${encKey(key)}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: controller.signal,
    });
    return res.ok;
  } finally {
    clearTimeout(timeout);
  }
}

async function r2Put(key: string, body: string, retries = 8): Promise<void> {
  if (!R2 || !apiToken) throw new Error("Missing Cloudflare R2 credentials");
  let last = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${R2}/${encKey(key)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain; charset=utf-8" },
        body,
        signal: controller.signal,
      });
      if (res.ok) return;
      last = `${res.status} ${await res.text()}`;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
        continue;
      }
      throw new Error(`R2 put ${key}: ${last}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`R2 put ${key}: failed after ${retries} attempts; last=${last}`);
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item, index);
    }
  });
  await Promise.all(workers);
}

const NICHE_RULES: Record<Exclude<Niche, "general">, { terms: string[]; mechanics: string[] }> = {
  "tower-defense": {
    terms: ["tower defense", "tower", "td", "defense", "defend", "wave", "waves", "turret", "enemy", "enemies", "mob", "path", "placement", "plants vs zombies", "pvz", "zombie tower"],
    mechanics: ["wave progression", "placement system", "enemy pathing"],
  },
  fps: {
    terms: ["fps", "gun", "guns", "shoot", "shooter", "rifle", "pistol", "paintball", "battlefield", "phantom forces", "lasertag", "laser tag", "swat", "aim", "military", "war", "d-day", "armored patrol", "tank"],
    mechanics: ["combat", "client-server networking", "weapons"],
  },
  obby: {
    terms: ["obby", "obstacle", "parkour", "jump", "checkpoint", "stage", "course", "deathrun", "tower of hell", "flood escape", "hole in the wall", "cave run", "escape"],
    mechanics: ["checkpoint progression", "platforming"],
  },
  rpg: {
    terms: ["rpg", "quest", "npc", "dungeon", "adventure", "magic", "spell", "skill", "sword", "hero", "pokemon", "project pokemon", "brick bronze", "bluesteel", "one piece", "naruto", "fairy tail", "swordburst", "rocraft", "demon", "hunting", "medieval", "rocraft", "level", "xp"],
    mechanics: ["quests", "player progression", "combat"],
  },
  simulator: {
    terms: ["simulator", "sim", "pet", "pets", "egg", "hatch", "mining", "mine", "click", "clicker", "idle", "rebirth", "farm", "farming", "limited simulator", "case clicker", "snapping sim", "stock sim", "azure mines"],
    mechanics: ["economy", "player progression", "collection loop"],
  },
  tycoon: {
    terms: ["tycoon", "factory", "dropper", "conveyor", "income", "cashier", "business", "empire", "store", "donation board", "coaster creator"],
    mechanics: ["economy", "base building", "player progression"],
  },
  "battle-royale": {
    terms: ["battle royale", "battle", "royale", "survive", "survival", "apocalypse", "last strike", "mad games", "murder mystery", "breakout", "zombie", "dead winter", "dead mist", "bomb shelter", "hunger games", "zone", "storm"],
    mechanics: ["round system", "survival", "combat"],
  },
  horror: {
    terms: ["horror", "scary", "haunted", "mansion", "forgotten memories", "nyctophobia", "isolation", "jumpscare", "monster", "baldi", "saw", "dark", "flee", "nightmare"],
    mechanics: ["survival", "atmosphere"],
  },
  racing: {
    terms: ["racing", "race", "car", "cars", "kart", "drive", "vehicle", "vehicles", "coaster", "skate", "track", "lap", "speed", "drift", "fire truck"],
    mechanics: ["vehicles", "race progression"],
  },
  social: {
    terms: ["social", "hangout", "roleplay", "rp", "city", "town", "life", "school", "highschool", "brookhaven", "rocitizens", "plaza", "starbucks", "mcdonalds", "homestore", "burger king", "club", "solaris", "nurse job", "las vegas", "london", "rome", "italy", "new york", "public", "hq", "showcase", "house", "avatar", "boho", "kestrel", "cold stone"],
    mechanics: ["roleplay", "user interface", "social systems"],
  },
};

const SERVICE_HINTS: Record<string, Partial<Record<Exclude<Niche, "general">, number>>> = {
  Teams: { fps: 1, "battle-royale": 1, social: 1 },
  PathfindingService: { "tower-defense": 2, rpg: 1 },
  DataStoreService: { simulator: 1, tycoon: 1, rpg: 1 },
  MarketplaceService: { simulator: 1, tycoon: 1, social: 1 },
  ProximityPromptService: { social: 1, tycoon: 1, rpg: 1 },
};

function loadLocalGames(): Map<string, LocalGame> {
  const byKey = new Map<string, LocalGame>();
  if (!existsSync(CONVERTED)) return byKey;

  for (const dir of readdirSync(CONVERTED)) {
    const gameDir = join(CONVERTED, dir);
    const manifestPath = join(gameDir, "manifest.json");
    if (!statSync(gameDir).isDirectory() || !existsSync(manifestPath)) continue;

    const metaPath = join(gameDir, "meta.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as string[];
    const meta = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>
      : {};
    const local = { dir: gameDir, manifest, metaPath, meta };

    byKey.set(slugify(dir), local);
    const metaName = typeof meta.name === "string" ? meta.name : "";
    if (metaName) byKey.set(slugify(metaName), local);
  }
  return byKey;
}

function findLocalGame(game: GameRow, locals: Map<string, LocalGame>): LocalGame | undefined {
  const direct = locals.get(slugify(game.name)) ?? locals.get(game.slug) ?? locals.get(game.slug.replace(/-[a-f0-9]{6}$/i, ""));
  if (direct) return direct;

  const baseSlug = game.slug.replace(/-[a-f0-9]{6}$/i, "");
  for (const [key, local] of locals) {
    if (key === baseSlug || key.startsWith(`${baseSlug}-`) || baseSlug.startsWith(`${key}-`)) return local;
  }
  return undefined;
}

function scoreTerms(haystack: string, terms: string[], multiplier: number): { score: number; hits: string[] } {
  const hits = terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
  });
  return { score: hits.reduce((sum, hit) => sum + Math.min(3, Math.max(1, hit.split(/\s+/).length)) * multiplier, 0), hits };
}

function manifestSignals(local?: LocalGame): { text: string; services: string[] } {
  if (!local) return { text: "", services: [] };
  const paths = local.manifest.join(" ");
  const services = unique(local.manifest.flatMap((path) => {
    const parts = path.replace(/^raw\//, "").split(/[/.\\]/g);
    return parts.filter((part) => /Service|Storage|Gui|Players|Workspace|Teams/i.test(part));
  }));
  return { text: paths, services };
}

function classifyGame(game: GameRow, local?: LocalGame): Classification {
  const existingMetaNiche = typeof local?.meta.niche === "string" ? local.meta.niche as Niche : undefined;
  if (existingMetaNiche && existingMetaNiche !== "general") {
    return {
      niche: existingMetaNiche,
      confidence: 99,
      reasons: [`existing meta.json niche=${existingMetaNiche}`],
      subniches: Array.isArray(local?.meta.subniches) ? local.meta.subniches.filter((v): v is string => typeof v === "string") : [],
      mechanics: Array.isArray(local?.meta.mechanics) ? local.meta.mechanics.filter((v): v is string => typeof v === "string") : [],
    };
  }

  const signals = manifestSignals(local);
  const titleHaystack = `${game.name} ${game.slug}`.toLowerCase();
  const manifestHaystack = signals.text.toLowerCase();
  const scores = new Map<Exclude<Niche, "general">, { score: number; reasons: string[] }>();

  for (const [niche, rule] of Object.entries(NICHE_RULES) as [Exclude<Niche, "general">, typeof NICHE_RULES[Exclude<Niche, "general">]][]) {
    const titleHit = scoreTerms(titleHaystack, rule.terms, 3);
    const manifestHit = scoreTerms(manifestHaystack, rule.terms, 1);
    scores.set(niche, {
      score: titleHit.score + manifestHit.score,
      reasons: unique([...titleHit.hits, ...manifestHit.hits], 6),
    });
  }

  for (const service of signals.services) {
    const hints = SERVICE_HINTS[service];
    if (!hints) continue;
    for (const [niche, bonus] of Object.entries(hints) as [Exclude<Niche, "general">, number][]) {
      const current = scores.get(niche);
      if (current) scores.set(niche, { score: current.score + bonus, reasons: [...current.reasons, service].slice(0, 6) });
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [bestNiche, best] = ranked[0];
  const runnerUp = ranked[1]?.[1].score ?? 0;
  if (!bestNiche || best.score < MIN_CONFIDENCE || best.score - runnerUp < 1) {
    return { niche: "general", confidence: best?.score ?? 0, reasons: best?.reasons ?? [], subniches: [], mechanics: [] };
  }

  const rule = NICHE_RULES[bestNiche];
  return {
    niche: bestNiche,
    confidence: best.score,
    reasons: best.reasons,
    subniches: unique(best.reasons.filter((r) => r.length > 2), 6),
    mechanics: rule.mechanics,
  };
}

function writeMeta(game: GameRow, local: LocalGame | undefined, c: Classification): void {
  if (!local) return;
  const next = {
    ...local.meta,
    name: typeof local.meta.name === "string" ? local.meta.name : game.name,
    niche: c.niche,
    subniches: c.subniches,
    mechanics: c.mechanics,
  };
  writeFileSync(local.metaPath, `${JSON.stringify(next, null, 2)}\n`);
}

async function repairRawR2(game: GameRow & { r2Prefix: string }, local: LocalGame): Promise<void> {
  const sourceBase = existsSync(join(local.dir, "raw")) ? join(local.dir, "raw") : local.dir;
  await r2Put(`${game.r2Prefix}manifest.json`, `${JSON.stringify(local.manifest, null, 2)}\n`);

  let uploaded = 0;
  await runPool(local.manifest, 1, async (filePath) => {
    const path = join(sourceBase, filePath.replace(/^raw\//, ""));
    if (!existsSync(path)) return;
    await r2Put(`${game.r2Prefix}${filePath}`, readFileSync(path, "utf8"));
    uploaded++;
    if (uploaded === 1 || uploaded % 25 === 0 || uploaded === local.manifest.length) {
      console.log(`   Repaired raw R2 ${game.slug}: ${uploaded}/${local.manifest.length}`);
    }
  });
}

async function runBun(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", args, { cwd: process.cwd(), stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`bun ${args.join(" ")} exited ${code}`)));
  });
}

async function main(): Promise<void> {
  if (REPAIR_MISSING_RAW) {
    const locals = loadLocalGames();
    const pending = await prisma.game.findMany({
      where: { ingested: false },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        niche: true,
        ingested: true,
        scriptCount: true,
        r2Prefix: true,
      },
      ...(LIMIT > 0 ? { take: LIMIT } : {}),
    }) as Array<GameRow & { r2Prefix: string }>;

    const missing: Array<{ game: GameRow & { r2Prefix: string }; local?: LocalGame }> = [];
    let checked = 0;
    console.log(`Missing raw R2 repair ${APPLY ? "(APPLY)" : "(DRY RUN)"}`);
    console.log(`Pending games to check: ${pending.length}`);
    await runPool(pending, 4, async (game) => {
      const hasManifest = await r2Exists(`${game.r2Prefix}manifest.json`);
      checked++;
      if (checked === 1 || checked % 50 === 0 || checked === pending.length) {
        console.log(`  Checked raw manifests: ${checked}/${pending.length}`);
      }
      if (!hasManifest) missing.push({ game, local: findLocalGame(game, locals) });
    });

    const repairable = missing.filter((m) => m.local);
    const unrepairable = missing.filter((m) => !m.local);
    console.log(`Missing raw manifests: ${missing.length}`);
    console.log(`Repairable from local converted folders: ${repairable.length}`);
    console.log(`No local converted match: ${unrepairable.length}`);
    for (const m of missing.slice(0, 40)) {
      console.log(`  ${m.game.slug}: ${m.game.r2Prefix}manifest.json${m.local ? "" : " (no local match)"}`);
    }

    if (!APPLY) {
      console.log("\nDry run only. Re-run with --repair-missing-raw --apply to restore missing raw R2 files.");
      return;
    }

    for (const { game, local } of repairable) {
      if (!local) continue;
      console.log(`\nRepairing missing raw R2 for ${game.slug} at ${game.r2Prefix}`);
      await repairRawR2(game, local);
    }

    console.log(`\nRepaired ${repairable.length} pending raw R2 game(s).`);
    if (unrepairable.length) {
      console.log("The remaining missing raw games need a local converted folder before they can be embedded.");
    }
    return;
  }

  if (REPAIR_STALE_INDEXES) {
    const locals = loadLocalGames();
    const stale = await prisma.$queryRaw<Array<GameRow & { r2Prefix: string; expectedIndex: string; actualIndexes: string[] }>>`
      select
        g.id,
        g.slug,
        g.name,
        g.niche,
        g.ingested,
        g.script_count as "scriptCount",
        g.r2_prefix as "r2Prefix",
        (${indexPrefix} || '-' || g.niche) as "expectedIndex",
        array_agg(distinct c.vectorize_index) as "actualIndexes"
      from games g
      join chunks c on c.game_id = g.id
      where g.ingested = true
        and c.vectorize_index <> (${indexPrefix} || '-' || g.niche)
      group by g.id
      order by g.created_at asc
      ${LIMIT > 0 ? Prisma.sql`limit ${LIMIT}` : Prisma.empty}
    `;

    console.log(`Stale Vectorize index repair ${REEMBED ? "(REEMBED)" : "(DRY RUN)"}`);
    console.log(`Stale ingested games: ${stale.length}`);
    for (const game of stale.slice(0, 40)) {
      console.log(`  ${game.slug}: ${game.actualIndexes.join(", ")} -> ${game.expectedIndex}`);
    }
    if (!REEMBED) {
      console.log("\nDry run only. Re-run with --repair-stale-indexes --reembed to cleanup and re-embed these games.");
      return;
    }
    for (const game of stale) {
      const hasManifest = await r2Exists(`${game.r2Prefix}manifest.json`);
      if (!hasManifest) {
        const local = findLocalGame(game, locals);
        if (!local) {
          console.log(`\nSkipping ${game.slug}: raw R2 manifest missing at ${game.r2Prefix}manifest.json and no matching local converted folder was found.`);
          continue;
        }
        console.log(`\nRepairing missing raw R2 for ${game.slug} at ${game.r2Prefix}`);
        await repairRawR2(game, local);
      }
      console.log(`\nRepairing stale vectors for ${game.slug}: ${game.actualIndexes.join(", ")} -> ${game.expectedIndex}`);
      await runBun(["run", "scripts/embed-games.ts", `--slug=${game.slug}`, "--cleanup"]);
      await runBun(["run", "scripts/embed-games.ts", `--slug=${game.slug}`]);
    }
    console.log(`\nRepaired ${stale.length} stale Vectorize-index game(s).`);
    return;
  }

  const locals = loadLocalGames();
  const rows = await prisma.game.findMany({
    where: ONLY_GENERAL ? { niche: "general" } : {},
    orderBy: { createdAt: "asc" },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  }) as GameRow[];

  const decisions = rows.map((game) => {
    const local = findLocalGame(game, locals);
    const classification = classifyGame(game, local);
    return { game, local, classification, changed: game.niche !== classification.niche };
  });

  const changed = decisions.filter((d) => d.changed);
  const movedIngested = changed.filter((d) => d.game.ingested);
  const byNiche = new Map<Niche, number>();
  for (const d of decisions) byNiche.set(d.classification.niche, (byNiche.get(d.classification.niche) ?? 0) + 1);

  console.log(`Corpus niche repair ${APPLY ? "(APPLY)" : "(DRY RUN)"}`);
  console.log(`Rows scanned: ${rows.length}`);
  console.log(`Changed labels: ${changed.length}`);
  console.log(`Already-ingested moved labels: ${movedIngested.length}`);
  console.log("\nNew classification distribution:");
  for (const [niche, count] of [...byNiche.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${niche.padEnd(15)} ${count}`);
  }

  console.log("\nSample changes:");
  for (const d of changed.slice(0, 40)) {
    console.log(`  ${d.game.slug}: ${d.game.niche} -> ${d.classification.niche} (${d.classification.confidence}; ${d.classification.reasons.join(", ") || "no reason"})${d.game.ingested ? " [ingested]" : ""}`);
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to update labels, or --apply --reembed to also move already-ingested vectors.");
    return;
  }

  for (const d of changed) {
    writeMeta(d.game, d.local, d.classification);
    await prisma.game.update({
      where: { id: d.game.id },
      data: {
        niche: d.classification.niche,
        subniches: d.classification.subniches,
        mechanics: d.classification.mechanics,
      },
    });
  }
  console.log(`\nUpdated ${changed.length} Postgres game row(s) and local meta.json files where available.`);

  if (!REEMBED) {
    console.log(`${movedIngested.length} already-ingested game(s) changed niche. Run again with --apply --reembed to cleanup and re-embed them automatically.`);
    return;
  }

  for (const d of movedIngested) {
    console.log(`\nMoving vectors for ${d.game.slug}: old=${d.game.niche} new=${d.classification.niche}`);
    await runBun(["run", "scripts/embed-games.ts", `--slug=${d.game.slug}`, "--cleanup"]);
    await runBun(["run", "scripts/embed-games.ts", `--slug=${d.game.slug}`]);
  }
  console.log(`\nRe-embedded ${movedIngested.length} moved already-ingested game(s).`);
}

try {
  await main();
} finally {
  await pool.end();
}
