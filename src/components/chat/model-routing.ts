import type { ProviderType } from "@/lib/providers/types";

type ServerProviders = Record<ProviderType, boolean>;

export function compatibleServerSelection(
  provider: ProviderType,
  model: string,
  configured: ServerProviders,
): { provider: ProviderType; model: string } | null {
  if (configured[provider]) return { provider, model };
  if (provider === "codex" && configured.openrouter && !model.includes("/")) {
    return { provider: "openrouter", model: `openai/${model}` };
  }
  return null;
}
