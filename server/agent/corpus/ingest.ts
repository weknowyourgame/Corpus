import type { CorpusConfig } from "./config.ts";
import { corpusConfig } from "./config.ts";
import type { GameMeta, IngestionReport } from "./types.ts";
import { getR2Object, putR2Object, embed, upsertVectors, createVectorizeIndex } from "./cloudflare.ts";
import { extractGameFiles } from "./extract.ts";
import { buildChunks } from "./chunk.ts";
import { getPendingGames, upsertChunks, markGameIngested } from "./postgres.ts";

const BATCH_SIZE = 50;

async function processGame(
  game: Awaited<ReturnType<typeof getPendingGames>>[number],
  config: CorpusConfig,
  report: IngestionReport,
): Promise<void> {
  const manifestJson = await getR2Object(`${game.r2Prefix}manifest.json`, config);
  if (!manifestJson) {
    report.errors.push(`${game.slug}: missing manifest.json in R2`);
    return;
  }
  const manifest: string[] = JSON.parse(manifestJson);

  const metaOverrideJson = await getR2Object(`${game.r2Prefix}meta.json`, config);
  const metaOverride = metaOverrideJson ? JSON.parse(metaOverrideJson) as Partial<GameMeta> : {};

  const meta: GameMeta = {
    slug: game.slug,
    name: game.name,
    niche: game.niche,
    subniches: game.subniches,
    mechanics: game.mechanics,
    services: game.services,
    qualityScore: game.qualityScore,
    ...metaOverride,
  };

  const files = await extractGameFiles(game.r2Prefix, manifest, meta, config);
  if (!files.length) {
    report.errors.push(`${game.slug}: no script files found in manifest`);
    return;
  }

  const chunks = buildChunks(meta, files, config.cloudflare.nicheIndexPrefix);
  const indexName = `${config.cloudflare.nicheIndexPrefix}-${meta.niche}`;
  await createVectorizeIndex(indexName, config);

  // Process in batches to avoid embedding rate limits
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await Promise.all(
      batch.map(async (chunk) => {
        const values = await embed(chunk.embedText, config);
        return {
          id: chunk.id,
          values,
          metadata: {
            gameSlug: chunk.gameSlug,
            gameName: chunk.gameName,
            niche: chunk.niche,
            chunkType: chunk.chunkType,
            r2Path: chunk.r2Path,
            robloxPath: chunk.robloxPath ?? "",
            qualityScore: chunk.qualityScore,
          },
        };
      }),
    );

    await Promise.all([
      upsertVectors(indexName, vectors, config),
      ...batch.map((chunk) => putR2Object(chunk.r2Path, chunk.content, config)),
    ]);
  }

  await upsertChunks(chunks, game.id);
  await markGameIngested(game.id, files.length);

  report.gamesProcessed += 1;
  report.chunksCreated += chunks.length;
  report.vectorsUpserted += chunks.length;
  console.log(`[corpus:ingest] ${game.slug}: ${files.length} files → ${chunks.length} chunks`);
}

export async function runIngestion(config: CorpusConfig = corpusConfig): Promise<IngestionReport> {
  const report: IngestionReport = { gamesProcessed: 0, chunksCreated: 0, vectorsUpserted: 0, errors: [] };
  if (!config.ready) {
    console.warn("[corpus:ingest] skipped — corpus not ready (missing credentials or disabled)");
    return report;
  }

  const games = await getPendingGames();
  if (!games.length) {
    console.log("[corpus:ingest] no pending games");
    return report;
  }

  console.log(`[corpus:ingest] processing ${games.length} game(s)`);
  for (const game of games) {
    try {
      await processGame(game, config, report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${game.slug}: ${msg}`);
      console.error(`[corpus:ingest] ${game.slug} failed:`, err);
    }
  }

  console.log(`[corpus:ingest] done — ${report.gamesProcessed} games, ${report.chunksCreated} chunks, ${report.errors.length} errors`);
  return report;
}

export function startIngestCron(
  config: CorpusConfig = corpusConfig,
  intervalMs = 60 * 60 * 1000,
): ReturnType<typeof setInterval> {
  if (!config.enabled) return setInterval(() => undefined, intervalMs);
  console.log(`[corpus:ingest] cron started, interval=${intervalMs / 1000}s`);
  void runIngestion(config);
  return setInterval(() => void runIngestion(config), intervalMs);
}
