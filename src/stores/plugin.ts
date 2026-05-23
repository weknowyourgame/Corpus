import { create } from "zustand";

/**
 * Plugin install status — browser-only (no desktop app).
 */

export interface PluginStatus {
  installed: boolean;
  path: string;
  is_current_version: boolean;
  plugins_folder: string;
}

export interface InstallResult {
  success: boolean;
  path: string;
  message: string;
}

interface PluginState {
  status: PluginStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  error: string | null;

  checkPlugin: () => Promise<void>;
  installPlugin: () => Promise<InstallResult>;
  getPluginsPath: () => Promise<string>;
}

const pluginsFolderHint = (): string => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "~/Documents/Roblox/Plugins";
  if (ua.includes("win")) return "%LOCALAPPDATA%\\Roblox\\Plugins";
  return "Roblox Studio → Plugins → Plugins Folder";
};

export const usePluginStore = create<PluginState>()((set) => ({
  status: null,
  isChecking: false,
  isInstalling: false,
  error: null,

  checkPlugin: async () => {
    set({ isChecking: true, error: null });
    set({
      status: {
        installed: false,
        path: "",
        is_current_version: false,
        plugins_folder: pluginsFolderHint(),
      },
      isChecking: false,
    });
  },

  installPlugin: async () => {
    set({ isInstalling: true, error: null });
    const folder = pluginsFolderHint();
    set({ isInstalling: false });
    return {
      success: false,
      path: folder,
      message: `Download the plugin, then copy stud-bridge.server.lua to: ${folder}`,
    };
  },

  getPluginsPath: async () => pluginsFolderHint(),
}));
