/**
 * ╔══════════════════════════════════════════════════════╗
 * ║              STUD AI MODEL CONFIGURATION             ║
 * ║                                                      ║
 * ║  All model choices live here. Change a model?        ║
 * ║  Edit this file only. Nothing else needs to change.  ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * HOW IT WORKS
 * ─────────────
 * User picks a Tier (Free / Pro / Hyper / Super)
 *   → resolves to a Profile (planner-pro, coder-pro, …)
 *   → Profile has a primary model + optional fallbacks
 *   → GatewayDriver sends the request through Cloudflare AI Gateway → OpenRouter
 *
 * MODELS ARE OPENROUTER IDs
 * ─────────────────────────
 * Use the format:  provider/model-name
 * Browse all models: https://openrouter.ai/models
 *
 * SPECIAL VALUES
 * ──────────────
 * "workers-ai-bge"  → uses Cloudflare Workers AI for embeddings (not OpenRouter)
 */

// ────────────────────────────────────────────────
//  TYPES  (no need to change these)
// ────────────────────────────────────────────────

export type Tier = "free" | "pro" | "hyper" | "super";
export type ProfileId =
  | "planner-free" | "planner-pro" | "planner-hyper" | "planner-super"
  | "coder-free"   | "coder-pro"   | "coder-hyper"   | "coder-super"
  | "classifier" | "summarizer" | "title-generator" | "embeddings";

export interface ModelSpec { model: string }
export interface ProfileConfig { primary: ModelSpec; fallbacks?: string[] }
export interface TierConfig { planner: ProfileId; coder: ProfileId }

// ────────────────────────────────────────────────
//  TIER → PROFILE MAPPING
//  Which profile is used for each user tier
// ────────────────────────────────────────────────

const tiers: Record<Tier, TierConfig> = {
  free:  { planner: "planner-free",  coder: "coder-free"  },
  pro:   { planner: "planner-pro",   coder: "coder-pro"   },
  hyper: { planner: "planner-hyper", coder: "coder-hyper" },
  super: { planner: "planner-super", coder: "coder-super" },
};

// ────────────────────────────────────────────────
//  PROFILE → MODEL MAPPING
//  Change a model here — that's the only place.
// ────────────────────────────────────────────────

const profiles: Record<ProfileId, ProfileConfig> = {

  // ── PLANNER (architecture, decomposition, reasoning) ─────────────────────
  "planner-free":  { primary: { model: "deepseek/deepseek-v3" } },
  "planner-pro":   { primary: { model: "anthropic/claude-sonnet-4-5" },       fallbacks: ["google/gemini-2.5-pro"] },
  "planner-hyper": { primary: { model: "anthropic/claude-opus-4-1" },         fallbacks: ["anthropic/claude-sonnet-4-5"] },
  "planner-super": { primary: { model: "anthropic/claude-opus-4-1" },         fallbacks: ["anthropic/claude-sonnet-4-5"] },

  // ── CODER (code generation, edits, debugging) ────────────────────────────
  "coder-free":    { primary: { model: "deepseek/deepseek-v3" } },
  "coder-pro":     { primary: { model: "anthropic/claude-sonnet-4-5" },       fallbacks: ["google/gemini-2.5-pro"] },
  "coder-hyper":   { primary: { model: "anthropic/claude-sonnet-4-5" },       fallbacks: ["anthropic/claude-opus-4-1"] },
  "coder-super":   { primary: { model: "anthropic/claude-opus-4-1" },         fallbacks: ["anthropic/claude-sonnet-4-5"] },

  // ── UTILITY PROFILES (internal tasks, not user-facing) ───────────────────
  "classifier":      { primary: { model: "deepseek/deepseek-v3" } },                         // cheap routing decisions
  "summarizer":      { primary: { model: "google/gemini-2.5-flash-lite-preview-06-17" } },   // conversation compression
  "title-generator": { primary: { model: "google/gemini-2.5-flash-lite-preview-06-17" } },   // chat title generation
  "embeddings":      { primary: { model: "workers-ai-bge" } },                               // RAG / semantic search

};

export const aiConfig = { tiers, profiles } as const;

export const TIER_LABELS: Record<Tier, string> = {
  free: "Free", pro: "Pro", hyper: "Hyper", super: "Super",
};
