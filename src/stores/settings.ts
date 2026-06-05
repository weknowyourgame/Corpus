import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tier } from "@/lib/ai/profiles";
import { bridgeUrl } from "@/lib/bridge/config";

export type { Tier };

export interface AppSettings {
  animationsEnabled: boolean;
  soundEnabled: false | boolean;
  compactMode: boolean;
  showToolDetails: boolean;
  autoScrollChat: boolean;
  confirmDestructiveActions: boolean;
  saveHistory: boolean;
  maxHistoryMessages: number;
}

type ServerSettings = {
  selectedTier?: Tier;
  devMode?: boolean;
  devModel?: string;
  appSettings?: Partial<AppSettings>;
};

export interface SettingsState {
  selectedTier: Tier;
  devMode: boolean;
  devModel: string;
  appSettings: AppSettings;
  /** Local-only full access preference. Server validates before accepting. */
  fullAccess: boolean;

  setTier: (tier: Tier) => void;
  setDevMode: (on: boolean) => void;
  setDevModel: (model: string) => void;
  setFullAccess: (on: boolean) => void;
  updateAppSettings: (settings: Partial<AppSettings>) => void;
  resetAppSettings: () => void;
  /** Fetch settings from server and merge over current state. No-op on 401. */
  loadFromServer: () => Promise<void>;
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

// Fire-and-forget. Server returns 401 when not authenticated — silently ignored.
const saveToServer = (patch: ServerSettings) => {
  fetch(bridgeUrl("/agent/user/settings"), {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      selectedTier: "pro",
      devMode: false,
      devModel: "",
      appSettings: DEFAULT_APP_SETTINGS,
      fullAccess: false,

      setTier: (tier) => {
        set({ selectedTier: tier });
        saveToServer({ selectedTier: tier });
      },

      setDevMode: (on) => {
        set({ devMode: on });
        saveToServer({ devMode: on });
      },

      setDevModel: (model) => {
        set({ devModel: model });
        saveToServer({ devModel: model });
      },

      setFullAccess: (on) => {
        set({ fullAccess: on });
        // Note: fullAccess is local-only; not synced to server — server validates via env.
      },

      updateAppSettings: (settings) => {
        set((state) => ({ appSettings: { ...state.appSettings, ...settings } }));
        saveToServer({ appSettings: settings });
      },

      resetAppSettings: () => {
        set({ appSettings: DEFAULT_APP_SETTINGS });
        saveToServer({ appSettings: DEFAULT_APP_SETTINGS });
      },

      loadFromServer: async () => {
        try {
          const res = await fetch(bridgeUrl("/agent/user/settings"), { credentials: "include" });
          if (!res.ok) return; // 401 when not logged in — keep localStorage state
          const data = await res.json() as { settings: ServerSettings | null };
          if (!data.settings) return;
          const { selectedTier, devMode, devModel, appSettings } = data.settings;
          const current = get();
          set({
            ...(selectedTier !== undefined ? { selectedTier } : {}),
            ...(devMode !== undefined ? { devMode } : {}),
            ...(devModel !== undefined ? { devModel } : {}),
            appSettings: { ...current.appSettings, ...(appSettings ?? {}) },
          });
        } catch {
          // network error — keep localStorage state
        }
      },
    }),
    {
      name: "corpus-settings",
      version: 5,
      migrate: () => ({
        selectedTier: "pro" as Tier,
        devMode: false,
        devModel: "",
        appSettings: DEFAULT_APP_SETTINGS,
      }),
    }
  )
);
