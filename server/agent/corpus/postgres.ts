import type { RawChunk } from "./types.ts";
import { getPrismaClient } from "../prisma.ts";

export type GameRow = {
  id: string;
  slug: string;
  name: string;
  niche: string;
  r2Prefix: string;
  subniches: string[];
  mechanics: string[];
  services: string[];
  qualityScore: number;
  ingested: boolean;
};

export async function getPendingGames(): Promise<GameRow[]> {
  const prisma = getPrismaClient();
  const rows = await prisma.game.findMany({ where: { ingested: false } });
  return rows as unknown as GameRow[];
}

export async function upsertChunks(chunks: RawChunk[], gameId: string): Promise<void> {
  const prisma = getPrismaClient();
  for (const chunk of chunks) {
    await prisma.corpusChunk.upsert({
      where: { vectorizeId: chunk.id },
      update: {
        r2Path: chunk.r2Path,
        title: chunk.title,
        systemName: chunk.systemName ?? null,
        filePath: chunk.filePath ?? null,
        robloxPath: chunk.robloxPath ?? null,
        scriptType: (chunk.scriptType as "server" | "client" | "module" | "shared" | "unknown") ?? null,
        lineStart: chunk.lineStart ?? null,
        lineEnd: chunk.lineEnd ?? null,
        qualityScore: chunk.qualityScore,
        symbols: chunk.symbols,
        services: chunk.services,
        remotes: chunk.remotes,
        requiredModules: chunk.requiredModules,
        tags: chunk.tags,
        sourceHash: chunk.sourceHash ?? null,
      },
      create: {
        id: chunk.id,
        gameId,
        chunkType: chunk.chunkType as "summary" | "system" | "script",
        vectorizeIndex: chunk.vectorizeIndex,
        vectorizeId: chunk.id,
        r2Path: chunk.r2Path,
        title: chunk.title,
        systemName: chunk.systemName ?? null,
        filePath: chunk.filePath ?? null,
        robloxPath: chunk.robloxPath ?? null,
        scriptType: (chunk.scriptType as "server" | "client" | "module" | "shared" | "unknown") ?? null,
        lineStart: chunk.lineStart ?? null,
        lineEnd: chunk.lineEnd ?? null,
        symbols: chunk.symbols,
        requiredModules: chunk.requiredModules,
        remotes: chunk.remotes,
        services: chunk.services,
        tags: chunk.tags,
        qualityScore: chunk.qualityScore,
        sourceHash: chunk.sourceHash ?? null,
      },
    });
  }
}

export async function markGameIngested(gameId: string, scriptCount: number): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.game.update({
    where: { id: gameId },
    data: { ingested: true, ingestedAt: new Date(), scriptCount },
  });
}

type ResolvedChunk = {
  r2Path: string;
  gameName: string;
  niche: string;
  qualityScore: number;
  services: string[];
  symbols: string[];
};

export async function resolveVectorizeIds(ids: string[]): Promise<Map<string, ResolvedChunk>> {
  if (!ids.length) return new Map();
  const prisma = getPrismaClient();
  const chunks = await prisma.corpusChunk.findMany({
    where: { vectorizeId: { in: ids } },
    include: { game: { select: { name: true, niche: true } } },
  });
  const map = new Map<string, ResolvedChunk>();
  for (const chunk of chunks) {
    const game = (chunk as typeof chunk & { game: { name: string; niche: string } }).game;
    map.set(chunk.vectorizeId, {
      r2Path: chunk.r2Path,
      gameName: game.name,
      niche: game.niche,
      qualityScore: chunk.qualityScore,
      services: chunk.services,
      symbols: chunk.symbols,
    });
  }
  return map;
}
