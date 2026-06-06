import { z } from "zod";
import type { AgentTier } from "../agent/types.ts";
import type { DiscordConfig } from "./types.ts";

const tierSchema = z.enum(["free", "pro", "hyper", "super"]);

const list = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const bool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const tier = (value: string | undefined): AgentTier => {
  const parsed = tierSchema.safeParse(value ?? "pro");
  return parsed.success ? parsed.data : "pro";
};

const commandName = (value: string | undefined) => {
  const name = value?.trim() || "corpus";
  return /^[a-z0-9_-]{1,32}$/.test(name) ? name : "corpus";
};

export const loadDiscordConfig = (): DiscordConfig => {
  const token = process.env.DISCORD_BOT_TOKEN?.trim() ?? "";
  const clientId = process.env.DISCORD_CLIENT_ID?.trim() ?? "";
  const requested = bool(process.env.CORPUS_DISCORD_ENABLED, Boolean(token));
  const enabled = requested && Boolean(token && clientId);

  if (requested && !enabled) {
    console.warn("[discord] disabled because DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID is missing");
  }

  return {
    enabled,
    token: enabled ? token : "",
    clientId: enabled ? clientId : "",
    guildIds: list(process.env.CORPUS_DISCORD_GUILD_IDS ?? process.env.DISCORD_GUILD_ID),
    allowedRoleIds: list(process.env.CORPUS_DISCORD_ALLOWED_ROLE_IDS),
    adminRoleIds: list(process.env.CORPUS_DISCORD_ADMIN_ROLE_IDS),
    commandName: commandName(process.env.CORPUS_DISCORD_COMMAND_NAME),
    registerCommands: bool(process.env.CORPUS_DISCORD_REGISTER_COMMANDS, true),
    requireMention: bool(process.env.CORPUS_DISCORD_REQUIRE_MENTION, false),
    defaultTier: tier(process.env.CORPUS_DISCORD_DEFAULT_TIER),
    fullAccess: bool(process.env.CORPUS_DISCORD_FULL_ACCESS, false) && process.env.CORPUS_FULL_ACCESS_ENABLED === "true",
    maxPromptLength: int(process.env.CORPUS_DISCORD_MAX_PROMPT_LENGTH, 6000),
  };
};
