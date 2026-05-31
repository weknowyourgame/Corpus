// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCorpusConfig } from "./config.ts";
import { buildCloudflareSetupCommands, formatCommand } from "./resources.ts";

describe("Cloudflare corpus resource commands", () => {
  it("builds R2 bucket command first", () => {
    const config = loadCorpusConfig({ CLOUDFLARE_R2_BUCKET: "my-games" });
    const commands = buildCloudflareSetupCommands(config);
    expect(formatCommand(commands[0])).toBe("wrangler r2 bucket create my-games");
  });

  it("builds niche Vectorize index commands with prefix", () => {
    const config = loadCorpusConfig({
      CLOUDFLARE_NICHE_INDEX_PREFIX: "roblox",
      CLOUDFLARE_R2_BUCKET: "my-games",
    });
    const commands = buildCloudflareSetupCommands(config);
    const indexCommands = commands.slice(1).map(formatCommand);
    expect(indexCommands).toContain("wrangler vectorize create roblox-tower-defense --dimensions=768 --metric=cosine");
    expect(indexCommands).toContain("wrangler vectorize create roblox-fps --dimensions=768 --metric=cosine");
    expect(indexCommands).toContain("wrangler vectorize create roblox-general --dimensions=768 --metric=cosine");
  });

  it("uses custom prefix from env", () => {
    const config = loadCorpusConfig({ CLOUDFLARE_NICHE_INDEX_PREFIX: "mygame" });
    const commands = buildCloudflareSetupCommands(config);
    const names = commands.slice(1).map((c) => c.args[2]);
    expect(names.every((n) => n.startsWith("mygame-"))).toBe(true);
  });
});
