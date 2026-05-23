/**
 * Prerequisite Check Store
 */

import { create } from "zustand";
import { isBridgeRunning, isStudioConnected } from "@/lib/roblox/client";
import { useSettingsStore } from "./settings";
import { isAuthenticated } from "@/lib/auth/codex";

export interface PrereqCheck {
  id: string;
  name: string;
  description: string;
  status: "pending" | "checking" | "passed" | "failed" | "warning";
  message?: string;
  action?: {
    label: string;
    handler: string;
  };
}

interface PrereqStore {
  checks: PrereqCheck[];
  isChecking: boolean;
  hasChecked: boolean;
  showWizard: boolean;

  runAllChecks: () => Promise<void>;
  dismissWizard: () => void;
  getFailedChecks: () => PrereqCheck[];
  getWarningChecks: () => PrereqCheck[];
}

const initialChecks: PrereqCheck[] = [
  {
    id: "roblox-studio",
    name: "Roblox Studio",
    description: "Roblox Studio must be installed on your computer",
    status: "pending",
  },
  {
    id: "stud-plugin",
    name: "Stud Plugin",
    description: "The stud-bridge plugin must be installed in Studio",
    status: "pending",
  },
  {
    id: "api-provider",
    name: "AI Provider",
    description: "An API key or ChatGPT Plus/Pro login is required",
    status: "pending",
  },
  {
    id: "bridge-server",
    name: "Bridge Server",
    description: "The bridge server connects the web app to Roblox Studio",
    status: "pending",
  },
  {
    id: "studio-connection",
    name: "Studio Connection",
    description: "Roblox Studio should be connected via the plugin",
    status: "pending",
  },
];

export const usePrereqStore = create<PrereqStore>((set, get) => ({
  checks: initialChecks,
  isChecking: false,
  hasChecked: false,
  showWizard: false,

  runAllChecks: async () => {
    set({ isChecking: true });

    const checks = [...initialChecks];

    const updateCheck = (id: string, update: Partial<PrereqCheck>) => {
      const idx = checks.findIndex((c) => c.id === id);
      if (idx !== -1) checks[idx] = { ...checks[idx], ...update };
    };

    updateCheck("roblox-studio", { status: "checking" });
    set({ checks: [...checks] });
    updateCheck("roblox-studio", {
      status: "passed",
      message: "Install Roblox Studio if you have not already",
    });
    set({ checks: [...checks] });

    updateCheck("stud-plugin", { status: "checking" });
    set({ checks: [...checks] });
    updateCheck("stud-plugin", {
      status: "warning",
      message: "Download and install the plugin from the connection screen",
      action: { label: "Download Plugin", handler: "install-plugin" },
    });
    set({ checks: [...checks] });

    updateCheck("api-provider", { status: "checking" });
    set({ checks: [...checks] });

    const { hasApiKey } = useSettingsStore.getState();
    const hasOpenAI = hasApiKey("openai");
    const hasAnthropic = hasApiKey("anthropic");
    const hasOAuth = isAuthenticated();

    if (hasOpenAI || hasAnthropic || hasOAuth) {
      const providers = [];
      if (hasOAuth) providers.push("ChatGPT Plus/Pro");
      if (hasOpenAI) providers.push("OpenAI");
      if (hasAnthropic) providers.push("Anthropic");
      updateCheck("api-provider", {
        status: "passed",
        message: `Configured: ${providers.join(", ")}`,
      });
    } else {
      updateCheck("api-provider", {
        status: "failed",
        message: "No AI provider configured",
        action: { label: "Open Settings", handler: "open-settings" },
      });
    }
    set({ checks: [...checks] });

    updateCheck("bridge-server", { status: "checking" });
    set({ checks: [...checks] });

    const bridgeUp = await isBridgeRunning();
    if (bridgeUp) {
      updateCheck("bridge-server", { status: "passed", message: "Bridge server is running" });
    } else {
      updateCheck("bridge-server", {
        status: "failed",
        message: "Bridge server not running — run npm run dev",
        action: { label: "See README", handler: "restart-app" },
      });
    }
    set({ checks: [...checks] });

    updateCheck("studio-connection", { status: "checking" });
    set({ checks: [...checks] });

    const studioUp = await isStudioConnected();
    if (studioUp) {
      updateCheck("studio-connection", { status: "passed", message: "Studio is connected" });
    } else {
      updateCheck("studio-connection", {
        status: "warning",
        message: "Enter your session code in the Studio plugin and connect",
        action: { label: "Connect Studio", handler: "show-connection-help" },
      });
    }
    set({ checks: [...checks] });

    const failedChecks = checks.filter((c) => c.status === "failed");
    set({
      checks,
      isChecking: false,
      hasChecked: true,
      showWizard: failedChecks.length > 0,
    });
  },

  dismissWizard: () => {
    set({ showWizard: false });
  },

  getFailedChecks: () => get().checks.filter((c) => c.status === "failed"),

  getWarningChecks: () => get().checks.filter((c) => c.status === "warning"),
}));
