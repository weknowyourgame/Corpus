import { create } from "zustand";
import { bridgeUrl } from "@/lib/bridge/config";

export type AuthUser = {
  id: string | null;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  anonymous: boolean;
};

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  devLoginToken: string | null;
  loadMe: () => Promise<void>;
  startEmailLogin: (email: string) => Promise<void>;
  verifyEmailLogin: (email: string, token: string) => Promise<void>;
  startGoogleLogin: () => Promise<void>;
  finishGoogleLogin: (code: string, state: string) => Promise<void>;
  logout: () => Promise<void>;
};

const authFetch = (path: string, init?: RequestInit) =>
  fetch(bridgeUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  error: null,
  devLoginToken: null,

  loadMe: async () => {
    set({ loading: true, error: null });
    try {
      const res = await authFetch("/auth/me");
      if (res.status === 401) {
        set({ user: null, loading: false });
        return;
      }
      if (!res.ok) throw new Error("Could not load auth session");
      const data = await res.json() as { user: AuthUser };
      set({ user: data.user, loading: false });
    } catch (error) {
      set({ user: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  startEmailLogin: async (email) => {
    set({ error: null, devLoginToken: null });
    try {
      const res = await authFetch("/auth/login/start", {
        method: "POST",
        body: JSON.stringify({ provider: "email", email }),
      });
      const data = await res.json() as { error?: string; loginToken?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not start login");
      set({ devLoginToken: data.loginToken ?? null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  verifyEmailLogin: async (email, token) => {
    set({ error: null });
    try {
      const res = await authFetch("/auth/login/verify", {
        method: "POST",
        body: JSON.stringify({ provider: "email", email, token }),
      });
      const data = await res.json() as { user?: AuthUser; error?: string };
      if (!res.ok || !data.user) throw new Error(data.error ?? "Could not verify login");
      set({ user: data.user, loading: false, devLoginToken: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  startGoogleLogin: async () => {
    set({ error: null });
    try {
      const redirectUri = window.location.origin + window.location.pathname;
      const res = await authFetch("/auth/login/start", {
        method: "POST",
        body: JSON.stringify({ provider: "google", redirectUri }),
      });
      const data = await res.json() as { authUrl?: string | null; error?: string };
      if (!res.ok || !data.authUrl) throw new Error(data.error ?? "Google OAuth is not configured");
      window.location.assign(data.authUrl);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  finishGoogleLogin: async (code, state) => {
    set({ loading: true, error: null });
    const redirectUri = window.location.origin + window.location.pathname;
    const res = await authFetch("/auth/login/verify", {
      method: "POST",
      body: JSON.stringify({ provider: "google", code, state, redirectUri }),
    });
    const data = await res.json() as { user?: AuthUser; error?: string };
    if (!res.ok || !data.user) throw new Error(data.error ?? "Could not finish Google login");
    window.history.replaceState({}, document.title, window.location.pathname);
    set({ user: data.user, loading: false });
  },

  logout: async () => {
    await authFetch("/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    set({ user: null, loading: false, devLoginToken: null });
    await get().loadMe();
  },
}));
