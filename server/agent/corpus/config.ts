export type CorpusConfig = {
  enabled: boolean;
  maxChunks: number;
  contextMaxChars: number;
  cloudflare: {
    accountId: string;
    apiToken: string;
    r2Bucket: string;
    nicheIndexPrefix: string;
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
const DEFAULT_INDEX_PREFIX = "roblox";

const bool = (v: string | undefined) => v?.toLowerCase() === "true" || v === "1";
const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const str = (v: string | undefined, fallback = "") => v?.trim() || fallback;

export function loadCorpusConfig(env: NodeJS.ProcessEnv = process.env): CorpusConfig {
  const enabled = bool(env.CORPUS_ENABLED);
  const cloudflare = {
    accountId: str(env.CLOUDFLARE_ACCOUNT_ID),
    apiToken: str(env.CLOUDFLARE_API_TOKEN),
    r2Bucket: str(env.CLOUDFLARE_R2_BUCKET, DEFAULT_R2_BUCKET),
    nicheIndexPrefix: str(env.CLOUDFLARE_NICHE_INDEX_PREFIX, DEFAULT_INDEX_PREFIX),
    workersAiEmbedModel: str(env.CLOUDFLARE_WORKERS_AI_EMBED_MODEL, DEFAULT_EMBED_MODEL),
  };
  const databaseUrl = str(env.DATABASE_URL);
  const required = {
    CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId,
    CLOUDFLARE_API_TOKEN: cloudflare.apiToken,
    DATABASE_URL: databaseUrl,
  };
  const missing = enabled
    ? Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
    : [];

  return {
    enabled,
    maxChunks: int(env.CORPUS_MAX_CHUNKS, DEFAULT_MAX_CHUNKS),
    contextMaxChars: int(env.CORPUS_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS),
    cloudflare,
    databaseUrl,
    ready: enabled && missing.length === 0,
    missing,
  };
}

export const corpusConfig = loadCorpusConfig();
