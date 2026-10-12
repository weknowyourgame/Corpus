// Removed — model type system replaced by tier/profile architecture.
export type DisplayModel = { id: string; name: string; provider: string };
export type ProvidersData = Record<string, unknown>;
export const FALLBACK_CODEX_MODELS: DisplayModel[] = [];
