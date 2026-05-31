// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCorpusConfig } from "./config.ts";
import { buildCloudflareSetupCommands, formatCommand } from "./resources.ts";

describe("Cloudflare corpus resource commands", () => {
  it("builds R2 and Vectorize setup commands from config", () => {
    const config = loadCorpusConfig({
      CLOUDFLARE_R2_BUCKET: "my-games",
      CLOUDFLARE_VECTORIZE_GAME_INDEX: "game-index",
      CLOUDFLARE_VECTORIZE_SYSTEM_INDEX: "system-index",
      CLOUDFLARE_VECTORIZE_SCRIPT_INDEX: "script-index",
      CLOUDFLARE_VECTORIZE_PATTERN_INDEX: "pattern-index",
    });

    const commands = buildCloudflareSetupCommands(config);

    expect(commands).toHaveLength(5);
    expect(formatCommand(commands[0])).toBe("wrangler r2 bucket create my-games");
    expect(commands.slice(1).map(formatCommand)).toEqual([
      "wrangler vectorize create game-index --dimensions=768 --metric=cosine",
      "wrangler vectorize create system-index --dimensions=768 --metric=cosine",
      "wrangler vectorize create script-index --dimensions=768 --metric=cosine",
      "wrangler vectorize create pattern-index --dimensions=768 --metric=cosine",
    ]);
  });
});
