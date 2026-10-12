// Removed — model fetching deleted. Models are internal to AI Gateway config.
export const FALLBACK_CODEX_MODELS: unknown[] = [];
export function clearModelsCache() {}
export function getModelsWithCache() { return Promise.reject(new Error("removed")); }
export function extractCodexModels() { return []; }
