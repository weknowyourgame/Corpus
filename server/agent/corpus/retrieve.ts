import type { CorpusConfig } from "./config.ts";
import { corpusConfig } from "./config.ts";
import type { CorpusRetrievalResult, CorpusChunkResult, ChunkType } from "./types.ts";
import { embed, queryVectors, getR2Object } from "./cloudflare.ts";
import { resolveVectorizeIds } from "./postgres.ts";

// Short casual/meta inputs that never need corpus context.
const CASUAL_RE = /^(hi+|hey+|hello+|howdy|sup|yo|thanks?|thank\s+you|thx|ok+|okay|sure|yep+|nope|cool|nice|great|awesome|lol+|haha+|wow|good\s+(morning|afternoon|evening|night))[!?.,\s]*$/i;
const META_RE = /\b(what\s+can\s+you\s+do|what\s+do\s+you\s+do|how\s+do\s+you\s+work|what\s+are\s+you|who\s+are\s+you|are\s+you\s+(claude|gpt|an?\s+ai|a\s+bot)|what('s|\s+is)\s+(your\s+(name|purpose)|stud)|what\s+(model|llm|version)\s+(are|is)\s+you)\b/i;

// Any of these terms signals Roblox/game/scripting intent → corpus is useful.
const GAME_TERMS_RE = /\b(roblox|rbxl?|luau|studio(?:\.lua)?|serverscriptservice|localscript|modulescript|remoteevent|remotefunction|bindableevent|bindablefunction|startergui|starterpack|replicatedstorage|datastore(?:service)?|humanoid|leaderstats|playeradded|playerremoving|characteradded|gamepass|devproduct|badgeservice|tweenservice|runservice|collectionservice|httpservice|marketplaceservice|groupservice|tycoon|obby|simulator|combat(\s+system)?|inventory(\s+system)?|round(\s+system)?|npc|tower\s+defense|battle\s+royale|placement(\s+system)?|monetization|screengui|textlabel|textbutton|imagelabel|viewportframe|health|damage|kill|die|respawn|revive|coins?|gems?|cash|currency|money|shop|store|buy|sell|purchase|inventory|item|weapon|gun|sword|tool|ability|skill|power|boost|speed|jump|stamina|sprint|dash|dodge|attack|defend|shield|armor|loot|drop|pickup|script|function|module|bind|connect|event|fire|invoke|signal|loop|timer|wait|delay|debounce|cooldown|trigger|detect|hit|touch|overlap|raycast|region3|cframe|vector3|tween|lerp|animate|track|weld|constraint|joint|gui|button|label|frame|screen|menu|hud|popup|dialog|prompt|notification|billboard|surface|part|model|mesh|union|texture|decal|particle|effect|sound|music|ambient|light|shadow|fog|sky|terrain|water|baseplate|workspace|folder|value|attribute|leaderboard|stats|points|score|rank|level|xp|exp|badge|pass|product|vip|team|group|spectator|spawn|death)\b/i;

/**
 * Returns true only when the query clearly calls for Roblox game/code examples.
 * Casual greetings, meta questions, and model questions are always skipped.
 */
export function shouldUseCorpus(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 4) return false;
  if (CASUAL_RE.test(trimmed)) return false;
  if (META_RE.test(trimmed)) return false;
  return GAME_TERMS_RE.test(trimmed);
}

const NICHE_KEYWORDS: Record<string, string[]> = {
  "tower-defense": ["tower", "defense", "defend", "wave", "enemy", "placement", "turret", "mob", "path"],
  "fps": ["fps", "gun", "shoot", "bullet", "rifle", "weapon", "aim", "fire", "combat", "kill", "damage", "hitbox"],
  "obby": ["obby", "obstacle", "parkour", "jump", "platform", "checkpoint", "flood", "stage", "course", "finish"],
  "rpg": ["rpg", "quest", "npc", "xp", "experience", "skill", "dungeon", "adventure", "magic", "spell", "level up", "stat"],
  "simulator": ["simulator", "sim", "pet", "mining", "farming", "click", "idle", "rebirth", "hatch", "egg", "boost"],
  "tycoon": ["tycoon", "factory", "dropper", "conveyor", "income", "collect", "upgrade", "base", "build"],
  "battle-royale": ["battle royale", "br", "zone", "shrink", "last man", "survival", "storm", "ring", "safe zone"],
  "horror": ["horror", "scary", "monster", "flee", "escape room", "jumpscare", "darkness", "flashlight"],
  "racing": ["racing", "car", "vehicle", "drift", "speed", "track", "lap", "finish line", "nitro"],
  "social": ["social", "hangout", "roleplay", "rp", "emote", "dance", "house", "chat", "avatar"],
  "general": [],
};

function detectNiche(query: string): { niche: string | null; confidence: number } {
  const lower = query.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = niche; }
  }
  return { niche: best, confidence: bestScore };
}

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 120);
const log = (config: CorpusConfig, message: string, extra?: unknown) => {
  if (!config.logRetrieval) return;
  if (extra === undefined) {
    console.log(`[corpus:retrieve] ${message}`);
    return;
  }
  console.log(`[corpus:retrieve] ${message}`, extra);
};

export async function retrieveCorpusContext(
  input: { query: string; maxChunks?: number; signal?: AbortSignal },
  config: CorpusConfig = corpusConfig,
): Promise<CorpusRetrievalResult> {
  if (!config.ready) {
    log(config, `skipped; corpus disabled or missing env (${config.missing.join(", ") || "not enabled"})`);
    return { chunks: [], detectedNiche: null, totalFound: 0 };
  }

  if (!shouldUseCorpus(input.query)) {
    log(config, `skipped by intent gate; query="${preview(input.query)}"`);
    return { chunks: [], detectedNiche: null, totalFound: 0 };
  }

  const maxChunks = input.maxChunks ?? config.maxChunks;
  const { niche, confidence } = detectNiche(input.query);
  log(config, `query="${preview(input.query)}" maxChunks=${maxChunks} detectedNiche=${niche ?? "none"} confidence=${confidence}`);

  let vector: number[];
  try {
    log(config, `embedding query with ${config.cloudflare.workersAiEmbedModel}`);
    vector = await embed(input.query, config);
    log(config, `embedding complete dims=${vector.length}`);
  } catch (err) {
    console.warn("[corpus:retrieve] embed failed:", err);
    return { chunks: [], detectedNiche: niche, totalFound: 0 };
  }

  const prefix = config.cloudflare.nicheIndexPrefix;
  const ALL_NICHES = Object.keys(NICHE_KEYWORDS);
  const searches: Promise<{ indexName: string; matches: { id: string; score: number; metadata: Record<string, string | number | boolean> }[] }>[] = [];

  const searchIndex = async (indexName: string, topK: number) => {
    log(config, `Vectorize query index=${indexName} topK=${topK}`);
    const matches = await queryVectors(indexName, vector, topK, config).catch((err) => {
      log(config, `Vectorize query failed index=${indexName}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    log(config, `Vectorize returned ${matches.length} match(es) from ${indexName}`);
    for (const match of matches.slice(0, 8)) {
      log(config, `  match id=${match.id} score=${match.score.toFixed(4)} game=${String(match.metadata.gameName ?? match.metadata.gameSlug ?? "?")} type=${String(match.metadata.chunkType ?? "?")} path=${String(match.metadata.robloxPath ?? match.metadata.r2Path ?? "")}`);
    }
    return { indexName, matches };
  };

  if (niche && confidence >= 2) {
    searches.push(searchIndex(`${prefix}-${niche}`, 12));
    if (niche !== "general") searches.push(searchIndex(`${prefix}-general`, 4));
  } else {
    for (const n of ALL_NICHES) searches.push(searchIndex(`${prefix}-${n}`, 4));
  }

  const searched = await Promise.all(searches);
  const allMatches = searched.flatMap((result) => result.matches);
  if (!allMatches.length) {
    log(config, "no Vectorize matches; returning no corpus chunks");
    return { chunks: [], detectedNiche: niche, totalFound: 0 };
  }

  const seen = new Map<string, typeof allMatches[number]>();
  for (const r of allMatches) {
    const existing = seen.get(r.id);
    if (!existing || r.score > existing.score) seen.set(r.id, r);
  }
  const deduped = [...seen.values()].sort((a, b) => b.score - a.score);
  log(config, `deduped ${allMatches.length} match(es) -> ${deduped.length} unique vector id(s)`);

  const bestScore = deduped[0]?.score ?? 0;
  if (bestScore < config.minScore) {
    log(config, `score gate filtered: best=${bestScore.toFixed(4)} threshold=${config.minScore.toFixed(4)} top3=[${deduped.slice(0, 3).map((r) => r.score.toFixed(4)).join(", ")}]`);
    return { chunks: [], detectedNiche: niche, totalFound: deduped.length };
  }

  let resolved: Awaited<ReturnType<typeof resolveVectorizeIds>>;
  try {
    log(config, `resolving ${deduped.length} vector id(s) in Postgres`);
    resolved = await resolveVectorizeIds(deduped.map((r) => r.id));
    log(config, `Postgres resolved ${resolved.size}/${deduped.length} vector id(s)`);
  } catch (err) {
    console.warn("[corpus:retrieve] postgres resolve failed:", err);
    return { chunks: [], detectedNiche: niche, totalFound: 0 };
  }

  const chunks: CorpusChunkResult[] = [];
  let totalChars = 0;

  for (const match of deduped) {
    if (chunks.length >= maxChunks) break;
    const meta = resolved.get(match.id);
    if (!meta) {
      log(config, `skip id=${match.id}; no Postgres row`);
      continue;
    }

    let content: string | null;
    try {
      log(config, `fetching R2 chunk id=${match.id} r2=${meta.r2Path}`);
      content = await getR2Object(meta.r2Path, config);
    } catch (err) {
      log(config, `R2 fetch failed id=${match.id} r2=${meta.r2Path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!content) {
      log(config, `skip id=${match.id}; empty/missing R2 content r2=${meta.r2Path}`);
      continue;
    }

    const budget = config.contextMaxChars - totalChars;
    if (budget <= 0) break;
    const sliced = content.slice(0, budget);
    totalChars += sliced.length;

    const vmeta = match.metadata;
    chunks.push({
      vectorizeId: match.id,
      score: match.score,
      r2Path: meta.r2Path,
      gameName: meta.gameName,
      niche: meta.niche,
      chunkType: (vmeta.chunkType as ChunkType) ?? "script",
      robloxPath: (vmeta.robloxPath as string) || undefined,
      services: meta.services,
      symbols: meta.symbols,
      content: sliced,
      qualityScore: meta.qualityScore,
    });
    log(config, `selected chunk #${chunks.length} score=${match.score.toFixed(4)} game="${meta.gameName}" niche=${meta.niche} type=${String(vmeta.chunkType ?? "script")} chars=${sliced.length}/${content.length} r2=${meta.r2Path}`);
  }

  log(config, `done selected=${chunks.length} totalFound=${deduped.length} totalChars=${totalChars}`);
  return { chunks, detectedNiche: niche, totalFound: deduped.length };
}
