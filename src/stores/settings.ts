import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tier } from "@/lib/ai/profiles";

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

export interface SettingsState {
  selectedTier: Tier;
  devMode: boolean;
  devModel: string;
  appSettings: AppSettings;

  setTier: (tier: Tier) => void;
  setDevMode: (on: boolean) => void;
  setDevModel: (model: string) => void;
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

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      selectedTier: "pro",
      devMode: false,
      devModel: "",
      appSettings: DEFAULT_APP_SETTINGS,

      setTier: (tier) => set({ selectedTier: tier }),
      setDevMode: (on) => set({ devMode: on }),
      setDevModel: (model) => set({ devModel: model }),

      updateAppSettings: (settings) =>
        set((state) => ({
          appSettings: { ...state.appSettings, ...settings },
        })),

      resetAppSettings: () => set({ appSettings: DEFAULT_APP_SETTINGS }),
    }),
    {
      name: "stud-settings",
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
