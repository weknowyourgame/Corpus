import { create } from "zustand";
import { getStudioStatus, isBridgeRunning, type StudioTransportStatus } from "@/lib/roblox";

export type { StudioTransportStatus };

export type ConnectionStatus = "disconnected" | "bridge_only" | "connected";

export interface RobloxState {
  status: ConnectionStatus;
  transport: StudioTransportStatus | null;
  lastCheck: Date | null;
  error: string | null;
  
  // Actions
  setStatus: (status: ConnectionStatus) => void;
  checkConnection: () => Promise<void>;
  startPolling: () => () => void;
}

export const useRobloxStore = create<RobloxState>()((set, get) => ({
  status: "disconnected",
  transport: null,
  lastCheck: null,
  error: null,

  setStatus: (status) => set({ status }),
  
  checkConnection: async () => {
    try {
      // First check if bridge is running
      const bridgeUp = await isBridgeRunning();
      if (!bridgeUp) {
        set({ status: "disconnected", transport: null, lastCheck: new Date(), error: null });
        return;
      }
      
      // Then check if Studio is connected
      const transport = await getStudioStatus();
      set({ 
        status: transport?.connected ? "connected" : "bridge_only",
        transport,
        lastCheck: new Date(),
        error: null 
      });
    } catch (e) {
      set({ 
        status: "disconnected", 
        transport: null,
        lastCheck: new Date(),
        error: e instanceof Error ? e.message : "Unknown error" 
      });
    }
  },
  
  startPolling: () => {
    // Initial check
    get().checkConnection();
    
    // Poll every 2 seconds
    const interval = setInterval(() => {
      get().checkConnection();
    }, 2000);
    
    // Return cleanup function
    return () => clearInterval(interval);
  },
}));
