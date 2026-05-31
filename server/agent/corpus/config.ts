export type CorpusSourceFormat = "filesystem_rojo";

export type CorpusConfig = {
  enabled: boolean;
  allowUnknownLicense: boolean;
  maxChunks: number;
  contextMaxChars: number;
  sourceFormat: CorpusSourceFormat;
  cloudflare: {
    accountId: string;
    apiToken: string;
    r2Bucket: string;
    vectorizeIndexes: {
      gameSummaries: string;
      systems: string;
      scripts: string;
      patterns: string;
    };
    workersAiEmbedModel: string;
  };
  databaseUrl: string;
  ready: boolean;
  missing: string[];
};

const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 12_000;
const DEFAULT_R2_BUCKET = "roblox-games";
const DEFAULT_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

const bool = (value: string | undefined): boolean =>
  value?.toLowerCase() === "true" || value === "1";

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const text = (value: string | undefined, fallback = ""): string =>
  value?.trim() || fallback;

export function loadCorpusConfig(env: NodeJS.ProcessEnv = process.env): CorpusConfig {
  const enabled = bool(env.CORPUS_ENABLED);
  const cloudflare = {
    accountId: text(env.CLOUDFLARE_ACCOUNT_ID),
    apiToken: text(env.CLOUDFLARE_API_TOKEN),
    r2Bucket: text(env.CLOUDFLARE_R2_BUCKET, DEFAULT_R2_BUCKET),
    vectorizeIndexes: {
      gameSummaries: text(env.CLOUDFLARE_VECTORIZE_GAME_INDEX, "roblox-game-summaries"),
      systems: text(env.CLOUDFLARE_VECTORIZE_SYSTEM_INDEX, "roblox-systems"),
      scripts: text(env.CLOUDFLARE_VECTORIZE_SCRIPT_INDEX, "roblox-scripts"),
      patterns: text(env.CLOUDFLARE_VECTORIZE_PATTERN_INDEX, "roblox-patterns"),
    },
    workersAiEmbedModel: text(env.CLOUDFLARE_WORKERS_AI_EMBED_MODEL, DEFAULT_EMBED_MODEL),
  };
  const databaseUrl = text(env.DATABASE_URL);
  const required = {
    CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId,
    CLOUDFLARE_API_TOKEN: cloudflare.apiToken,
    DATABASE_URL: databaseUrl,
  };
  const missing = enabled
    ? Object.entries(required).filter(([, value]) => !value).map(([key]) => key)
    : [];

  return {
    enabled,
    allowUnknownLicense: bool(env.CORPUS_ALLOW_UNKNOWN_LICENSE),
    maxChunks: positiveInt(env.CORPUS_MAX_CHUNKS, DEFAULT_MAX_CHUNKS),
    contextMaxChars: positiveInt(env.CORPUS_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS),
    sourceFormat: "filesystem_rojo",
    cloudflare,
    databaseUrl,
    ready: enabled && missing.length === 0,
    missing,
  };
}

export const corpusConfig = loadCorpusConfig();
