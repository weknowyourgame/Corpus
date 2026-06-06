import { CorpusDiscordBot } from "./bot.ts";
import { loadDiscordConfig } from "./config.ts";
import type { DiscordBotDeps } from "./types.ts";

export const startDiscordBot = async (deps: DiscordBotDeps) => {
  const config = loadDiscordConfig();
  if (!config.enabled) {
    console.log("[discord] disabled");
    return null;
  }
  const bot = new CorpusDiscordBot(config, deps);
  await bot.start();
  return bot;
};
