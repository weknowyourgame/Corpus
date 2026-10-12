/**
 * Frontend copy of the AI config (mirrors server/agent/ai-config.ts).
 * If you change a model, update BOTH files.
 *
 * Full model config lives in: server/agent/ai-config.ts
 */

import type { AiConfig } from "./types";

export const aiConfig: AiConfig = {
  tiers: {
    free:  { planner: "planner-free",  coder: "coder-free"  },
    pro:   { planner: "planner-pro",   coder: "coder-pro"   },
    hyper: { planner: "planner-hyper", coder: "coder-hyper" },
    super: { planner: "planner-super", coder: "coder-super" },
  },

  profiles: {
    "planner-free":    { primary: { model: "deepseek/deepseek-v3" } },
    "planner-pro":     { primary: { model: "anthropic/claude-sonnet-4-5" },     fallbacks: ["google/gemini-2.5-pro"] },
    "planner-hyper":   { primary: { model: "anthropic/claude-opus-4-1" },       fallbacks: ["anthropic/claude-sonnet-4-5"] },
    "planner-super":   { primary: { model: "anthropic/claude-opus-4-1" },       fallbacks: ["anthropic/claude-sonnet-4-5"] },

    "coder-free":      { primary: { model: "deepseek/deepseek-v3" } },
    "coder-pro":       { primary: { model: "anthropic/claude-sonnet-4-5" },     fallbacks: ["google/gemini-2.5-pro"] },
    "coder-hyper":     { primary: { model: "anthropic/claude-sonnet-4-5" },     fallbacks: ["anthropic/claude-opus-4-1"] },
    "coder-super":     { primary: { model: "anthropic/claude-opus-4-1" },       fallbacks: ["anthropic/claude-sonnet-4-5"] },

    "classifier":      { primary: { model: "deepseek/deepseek-v3" } },
    "summarizer":      { primary: { model: "deepseek/deepseek-v3" } },
    "title-generator": { primary: { model: "deepseek/deepseek-v3" } },
    "embeddings":      { primary: { model: "workers-ai-bge" } },
  },
};

export function resolveProfile(profileId: keyof typeof aiConfig.profiles) {
  return aiConfig.profiles[profileId];
}

export function resolveTierProfile(tier: keyof typeof aiConfig.tiers, role: "planner" | "coder") {
  return aiConfig.tiers[tier][role];
}
