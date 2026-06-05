import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bridgeUrl } from "@/lib/bridge/config";
import { setSessionId } from "@/lib/bridge/session";

interface StudioTokenState {
  token: string | null;
  sessionId: string | null;
  isGenerating: boolean;
  error: string | null;

  generate: () => Promise<void>;
  clear: () => void;
  checkStudioConnected: () => Promise<boolean>;
}

export const useStudioTokenStore = create<StudioTokenState>()(
  persist(
    (set, get) => ({
      token: null,
      sessionId: null,
      isGenerating: false,
      error: null,

      generate: async () => {
        set({ isGenerating: true, error: null });
        try {
          const { token: oldToken } = get();
          const res = await fetch(bridgeUrl("/auth/studio-token/generate"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldToken }),
          });
          if (!res.ok) throw new Error("Failed to generate token");
          const data = await res.json();
          setSessionId(data.sessionId);
          set({ token: data.token, sessionId: data.sessionId, isGenerating: false });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e), isGenerating: false });
        }
      },

      clear: () => {
        const { token } = get();
        if (token) {
          fetch(bridgeUrl("/auth/studio-token/revoke"), {
            method: "POST",
            credentials: "include",
            headers: { "X-Corpus-Token": token },
          }).catch(() => {});
        }
        set({ token: null, sessionId: null, error: null });
      },

      checkStudioConnected: async () => {
        const { token } = get();
        if (!token) return false;
        try {
          const res = await fetch(bridgeUrl("/auth/studio-token/validate"), {
            headers: { "X-Corpus-Token": token },
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return false;
          const data = await res.json();
          return data.studioConnected === true;
        } catch {
          return false;
        }
      },
    }),
    {
      name: "corpus-studio-token",
      partialize: (s) => ({ token: s.token, sessionId: s.sessionId }),
      onRehydrateStorage: () => (state) => {
        if (state?.sessionId) setSessionId(state.sessionId);
      },
    }
  )
);
