import type { CorpusConfig } from "./config.ts";
import { corpusConfig } from "./config.ts";
import type { CorpusRetrievalResult, CorpusChunkResult, ChunkType } from "./types.ts";
import { embed, queryVectors, getR2Object } from "./cloudflare.ts";
import { resolveVectorizeIds } from "./postgres.ts";

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

export async function retrieveCorpusContext(
  input: { query: string; maxChunks?: number; signal?: AbortSignal },
  config: CorpusConfig = corpusConfig,
): Promise<CorpusRetrievalResult> {
  if (!config.ready) return { chunks: [], detectedNiche: null, totalFound: 0 };

  const maxChunks = input.maxChunks ?? config.maxChunks;
  const { niche, confidence } = detectNiche(input.query);

  let vector: number[];
  try {
    vector = await embed(input.query, config);
  } catch (err) {
    console.warn("[corpus:retrieve] embed failed:", err);
    return { chunks: [], detectedNiche: niche, totalFound: 0 };
  }

  const prefix = config.cloudflare.nicheIndexPrefix;
  const searches: Promise<{ id: string; score: number; metadata: Record<string, string | number | boolean> }[]>[] = [];

  if (niche) searches.push(queryVectors(`${prefix}-${niche}`, vector, 12, config).catch(() => []));
  if (!niche || confidence < 2) {
    searches.push(queryVectors(`${prefix}-general`, vector, 8, config).catch(() => []));
  }

  const allMatches = (await Promise.all(searches)).flat();
  if (!allMatches.length) return { chunks: [], detectedNiche: niche, totalFound: 0 };

  const seen = new Map<string, typeof allMatches[number]>();
  for (const r of allMatches) {
    const existing = seen.get(r.id);
    if (!existing || r.score > existing.score) seen.set(r.id, r);
  }
  const deduped = [...seen.values()].sort((a, b) => b.score - a.score);

  let resolved: Awaited<ReturnType<typeof resolveVectorizeIds>>;
  try {
    resolved = await resolveVectorizeIds(deduped.map((r) => r.id));
  } catch (err) {
    console.warn("[corpus:retrieve] postgres resolve failed:", err);
    return { chunks: [], detectedNiche: niche, totalFound: 0 };
  }

  const chunks: CorpusChunkResult[] = [];
  let totalChars = 0;

  for (const match of deduped) {
    if (chunks.length >= maxChunks) break;
    const meta = resolved.get(match.id);
    if (!meta) continue;

    let content: string | null;
    try {
      content = await getR2Object(meta.r2Path, config);
    } catch {
      continue;
    }
    if (!content) continue;

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
  }

  return { chunks, detectedNiche: niche, totalFound: deduped.length };
}
