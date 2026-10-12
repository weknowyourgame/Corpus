import { aiConfig } from "./config";
import type { Tier, ProfileId } from "./types";

export type { Tier, ProfileId };

export const TIER_LABELS: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  hyper: "Hyper",
  super: "Super",
};

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  free: "Fast responses, essential features",
  pro: "Powerful AI for serious development",
  hyper: "Advanced reasoning, complex tasks",
  super: "Maximum capability, no limits",
};

export const ALL_TIERS: Tier[] = ["free", "pro", "hyper", "super"];

export function tierToCoderProfile(tier: Tier): ProfileId {
  return aiConfig.tiers[tier].coder;
}

export function tierToPlannerProfile(tier: Tier): ProfileId {
  return aiConfig.tiers[tier].planner;
}

export function profileModel(profileId: ProfileId): string {
  return aiConfig.profiles[profileId].primary.model;
}
