import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderType } from "@/lib/providers/types";

export type { ProviderType };

export interface ApiKeys {
  /** Anthropic API key (Claude / Claude Code) */
  anthropic?: string;
  /** OpenRouter API key */
  openrouter?: string;
}

export interface AppSettings {
  animationsEnabled: boolean;
  soundEnabled: boolean;
  compactMode: boolean;
  showToolDetails: boolean;
  autoScrollChat: boolean;
  confirmDestructiveActions: boolean;
  saveHistory: boolean;
  maxHistoryMessages: number;
}

export interface SettingsState {
  apiKeys: ApiKeys;
  selectedModel: string;
  selectedProvider: ProviderType;
  appSettings: AppSettings;

  setApiKey: (provider: keyof ApiKeys, key: string) => void;
  setSelectedModel: (model: string, provider: ProviderType) => void;
  hasApiKey: (provider: keyof ApiKeys) => boolean;
  getApiKey: (provider: keyof ApiKeys) => string | undefined;
  updateAppSettings: (settings: Partial<AppSettings>) => void;
  resetAppSettings: () => void;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  animationsEnabled: true,
  soundEnabled: false,
  compactMode: false,
  showToolDetails: true,
  autoScrollChat: true,
  confirmDestructiveActions: true,
  saveHistory: true,
  maxHistoryMessages: 100,
};

type PersistedSettings = {
  apiKeys?: ApiKeys & { openai?: string };
  selectedModel?: string;
  selectedProvider?: string;
  appSettings?: AppSettings;
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      apiKeys: {},
      selectedModel: "gpt-4o",
      selectedProvider: "codex",
      appSettings: DEFAULT_APP_SETTINGS,

      setApiKey: (provider, key) =>
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        })),

      setSelectedModel: (model, provider) =>
        set({
          selectedModel: model,
          selectedProvider: provider,
        }),

      hasApiKey: (provider) => {
        const key = get().apiKeys[provider];
        return !!key && key.length > 0;
      },

      getApiKey: (provider) => get().apiKeys[provider],

      updateAppSettings: (settings) =>
        set((state) => ({
          appSettings: { ...state.appSettings, ...settings },
        })),

      resetAppSettings: () =>
        set({ appSettings: DEFAULT_APP_SETTINGS }),
    }),
    {
      name: "stud-settings",
      version: 3,
      migrate: (persisted, version) => {
        const p = persisted as PersistedSettings;
        const keys = p.apiKeys ?? {};
        const { openai: _removed, ...rest } = keys;
        let provider = p.selectedProvider as ProviderType | string | undefined;
        if (provider === "openai") provider = "codex";
        provider = provider as ProviderType | undefined;
        const selectedModel = version < 3
          && provider === "openrouter"
          && p.selectedModel === "anthropic/claude-sonnet-4"
            ? "openai/gpt-4o"
            : p.selectedModel;
        return {
          ...p,
          apiKeys: rest,
          selectedModel,
          selectedProvider: provider ?? "codex",
        };
      },
    }
  )
);
