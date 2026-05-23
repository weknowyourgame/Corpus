/**
 * Models Store — Codex, Claude (Anthropic), and OpenRouter model lists
 */

import { create } from "zustand";
import type { ProvidersData, DisplayModel } from "@/lib/models/types";
import {
  getModelsWithCache,
  extractCodexModels,
  clearModelsCache,
  FALLBACK_CODEX_MODELS,
} from "@/lib/models/fetcher";
import { fetchClaudeModels, FALLBACK_CLAUDE_MODELS } from "@/lib/anthropic/models";
import { fetchOpenRouterModels } from "@/lib/openrouter/models";
import { useSettingsStore } from "./settings";

const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

interface ModelsState {
  providers: ProvidersData | null;
  codexModels: DisplayModel[];
  claudeModels: DisplayModel[];
  openrouterModels: DisplayModel[];
  isLoading: boolean;
  isLoadingClaude: boolean;
  isLoadingOpenRouter: boolean;
  lastFetched: number | null;
  lastClaudeFetched: number | null;
  lastOpenRouterFetched: number | null;
  error: string | null;

  fetchModels: () => Promise<void>;
  fetchClaudeModels: () => Promise<void>;
  fetchOpenRouterModels: () => Promise<void>;
  refreshModels: () => Promise<void>;
  clearModels: () => void;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
}

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

export const useModelsStore = create<ModelsState>((set, get) => ({
  providers: null,
  codexModels: FALLBACK_CODEX_MODELS,
  claudeModels: FALLBACK_CLAUDE_MODELS,
  openrouterModels: [],
  isLoading: false,
  isLoadingClaude: false,
  isLoadingOpenRouter: false,
  lastFetched: null,
  lastClaudeFetched: null,
  lastOpenRouterFetched: null,
  error: null,

  fetchModels: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });
    try {
      const providers = await getModelsWithCache();
      const codexModels = extractCodexModels(providers);
      set({
        providers,
        codexModels,
        lastFetched: Date.now(),
        isLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "Failed to fetch models",
        codexModels: get().codexModels.length > 0 ? get().codexModels : FALLBACK_CODEX_MODELS,
      });
    }
  },

  fetchClaudeModels: async () => {
    const key = useSettingsStore.getState().getApiKey("anthropic");
    if (!key) {
      set({ claudeModels: FALLBACK_CLAUDE_MODELS });
      return;
    }
    if (get().isLoadingClaude) return;
    set({ isLoadingClaude: true });
    try {
      const claudeModels = await fetchClaudeModels(key);
      set({ claudeModels, lastClaudeFetched: Date.now(), isLoadingClaude: false });
    } catch (error) {
      console.error("[Models] Claude fetch failed:", error);
      set({
        claudeModels: FALLBACK_CLAUDE_MODELS,
        isLoadingClaude: false,
        error: error instanceof Error ? error.message : "Failed to fetch Claude models",
      });
    }
  },

  fetchOpenRouterModels: async () => {
    const key = useSettingsStore.getState().getApiKey("openrouter");
    if (!key) {
      set({ openrouterModels: [] });
      return;
    }
    if (get().isLoadingOpenRouter) return;
    set({ isLoadingOpenRouter: true });
    try {
      const openrouterModels = await fetchOpenRouterModels(key);
      set({ openrouterModels, lastOpenRouterFetched: Date.now(), isLoadingOpenRouter: false });
    } catch (error) {
      console.error("[Models] OpenRouter fetch failed:", error);
      set({
        isLoadingOpenRouter: false,
        error: error instanceof Error ? error.message : "Failed to fetch OpenRouter models",
      });
    }
  },

  refreshModels: async () => {
    clearModelsCache();
    await get().fetchModels();
    await get().fetchClaudeModels();
    await get().fetchOpenRouterModels();
  },

  clearModels: () => {
    clearModelsCache();
    set({
      providers: null,
      codexModels: FALLBACK_CODEX_MODELS,
      claudeModels: FALLBACK_CLAUDE_MODELS,
      openrouterModels: [],
      lastFetched: null,
      lastClaudeFetched: null,
      lastOpenRouterFetched: null,
      error: null,
    });
  },

  startAutoRefresh: () => {
    if (autoRefreshTimer) return;
    autoRefreshTimer = setInterval(() => {
      get().refreshModels();
    }, AUTO_REFRESH_INTERVAL_MS);
  },

  stopAutoRefresh: () => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  },
}));

setTimeout(() => {
  useModelsStore.getState().fetchModels();
  useModelsStore.getState().startAutoRefresh();
}, 100);
