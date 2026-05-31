export type ChunkType = "summary" | "system" | "script";
export type ScriptType = "server" | "client" | "module" | "shared" | "unknown";

export type GameMeta = {
  slug: string;
  name: string;
  niche: string;
  subniches?: string[];
  mechanics?: string[];
  services?: string[];
  qualityScore?: number;
};

export type ScriptFile = {
  filePath: string;
  robloxPath: string;
  source: string;
  scriptType: ScriptType;
  symbols: string[];
  services: string[];
  remotes: string[];
  requiredModules: string[];
  lineCount: number;
  sourceHash: string;
};

export type RawChunk = {
  id: string;
  gameSlug: string;
  gameName: string;
  niche: string;
  chunkType: ChunkType;
  vectorizeIndex: string;
  r2Path: string;
  title: string;
  systemName?: string;
  filePath?: string;
  robloxPath?: string;
  scriptType?: ScriptType;
  lineStart?: number;
  lineEnd?: number;
  symbols: string[];
  requiredModules: string[];
  remotes: string[];
  services: string[];
  tags: string[];
  qualityScore: number;
  sourceHash?: string;
  content: string;
  embedText: string;
};

export type VectorRecord = {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean>;
};

export type VectorMatch = {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean>;
};

export type CorpusChunkResult = {
  vectorizeId: string;
  score: number;
  r2Path: string;
  gameName: string;
  niche: string;
  chunkType: ChunkType;
  robloxPath?: string;
  services: string[];
  symbols: string[];
  content: string;
  qualityScore: number;
};

export type CorpusRetrievalResult = {
  chunks: CorpusChunkResult[];
  detectedNiche: string | null;
  totalFound: number;
};

export type IngestionReport = {
  gamesProcessed: number;
  chunksCreated: number;
  vectorsUpserted: number;
  errors: string[];
};
