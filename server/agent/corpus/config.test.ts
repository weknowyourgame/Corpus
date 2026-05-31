// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCorpusConfig } from "./config.ts";

describe("corpus config", () => {
  it("is disabled and safe when no environment is provided", () => {
    const config = loadCorpusConfig({});

    expect(config.enabled).toBe(false);
    expect(config.ready).toBe(false);
    expect(config.missing).toEqual([]);
    expect(config.cloudflare.r2Bucket).toBe("roblox-games");
    expect(config.cloudflare.nicheIndexPrefix).toBe("roblox");
  });

  it("reports missing required services only when enabled", () => {
    const config = loadCorpusConfig({ CORPUS_ENABLED: "true" });

    expect(config.enabled).toBe(true);
    expect(config.ready).toBe(false);
    expect(config.missing).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "DATABASE_URL",
    ]);
  });

  it("is ready when enabled with required credentials", () => {
    const config = loadCorpusConfig({
      CORPUS_ENABLED: "1",
      CORPUS_MAX_CHUNKS: "12",
      CORPUS_CONTEXT_MAX_CHARS: "20000",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_R2_BUCKET: "custom-games",
      CLOUDFLARE_NICHE_INDEX_PREFIX: "mygame",
      DATABASE_URL: "postgres://example",
    });

    expect(config.ready).toBe(true);
    expect(config.maxChunks).toBe(12);
    expect(config.contextMaxChars).toBe(20_000);
    expect(config.cloudflare.r2Bucket).toBe("custom-games");
    expect(config.cloudflare.nicheIndexPrefix).toBe("mygame");
  });

  it("falls back on safe numeric defaults", () => {
    const config = loadCorpusConfig({
      CORPUS_MAX_CHUNKS: "nope",
      CORPUS_CONTEXT_MAX_CHARS: "-1",
    });

    expect(config.maxChunks).toBe(8);
    expect(config.contextMaxChars).toBe(12_000);
  });
});
