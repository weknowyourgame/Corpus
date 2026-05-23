import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bridgeUrl } from "@/lib/bridge/config";
import {
  OAuthAuth,
  getStoredAuth,
  clearAuth,
  startOAuthLogin,
  handleOAuthCallback,
  isAuthenticated,
} from "@/lib/auth/codex";
import { useModelsStore } from "./models";

export type AuthMethod = "api_key" | "oauth";

interface AuthState {
  authMethod: AuthMethod;
  oauthAuth: OAuthAuth | null;
  isLoggingIn: boolean;
  loginError: string | null;
  loginUrl: string | null;

  setAuthMethod: (method: AuthMethod) => void;
  startLogin: () => Promise<void>;
  completeLogin: (code: string, state: string) => Promise<void>;
  logout: () => void;
  checkOAuthCallback: () => Promise<boolean>;
  cancelLogin: () => void;
  isOAuthAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      authMethod: "api_key",
      oauthAuth: getStoredAuth(),
      isLoggingIn: false,
      loginError: null,
      loginUrl: null,

      setAuthMethod: (method) => {
        set({ authMethod: method });
      },

      startLogin: async () => {
        set({ isLoggingIn: true, loginError: null, loginUrl: null });
        try {
          const { url } = await startOAuthLogin();
          set({ loginUrl: url });
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (error) {
          set({
            loginError: error instanceof Error ? error.message : String(error),
          });
        }
      },

      cancelLogin: () => {
        set({ isLoggingIn: false, loginUrl: null, loginError: null });
      },

      completeLogin: async (code: string, state: string) => {
        set({ isLoggingIn: true, loginError: null });
        try {
          const auth = await handleOAuthCallback(code, state);
          set({
            oauthAuth: auth,
            isLoggingIn: false,
            authMethod: "oauth",
          });
          useModelsStore.getState().fetchModels();
        } catch (error) {
          set({
            loginError: error instanceof Error ? error.message : String(error),
            isLoggingIn: false,
          });
          throw error;
        }
      },

      logout: () => {
        clearAuth();
        useModelsStore.getState().clearModels();
        set({
          oauthAuth: null,
          authMethod: "api_key",
          loginError: null,
        });
      },

      checkOAuthCallback: async () => {
        try {
          const response = await fetch(bridgeUrl("/auth/poll"));
          if (!response.ok) return false;

          const data = await response.json();
          if (!data.pending) return false;

          const { code, state } = data;
          await fetch(bridgeUrl("/auth/clear"), { method: "POST" });

          if (code && state) {
            await get().completeLogin(code, state);
            return true;
          }
        } catch {
          // Bridge not running
        }
        return false;
      },

      isOAuthAuthenticated: () => isAuthenticated(),
    }),
    {
      name: "stud-auth",
      partialize: (state) => ({
        authMethod: state.authMethod,
      }),
    }
  )
);

export function useOAuthCallbackPoller() {
  const { checkOAuthCallback, isLoggingIn } = useAuthStore();

  if (typeof window !== "undefined" && isLoggingIn) {
    const interval = setInterval(async () => {
      const completed = await checkOAuthCallback();
      if (completed) clearInterval(interval);
    }, 1000);

    setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
  }
}
