/**
 * Bridge server URL — web app and Studio plugin both talk to this server.
 *
 * In dev, Vite proxies /stud, /auth, /codex, /api to localhost:3001.
 * In production, set VITE_BRIDGE_URL to your deployed bridge (e.g. https://api.stud.dev).
 */

export const getBridgeUrl = (): string => {
  const env = import.meta.env.VITE_BRIDGE_URL as string | undefined;
  if (env) return env.replace(/\/$/, "");
  // Same-origin proxy (vite dev or combined deploy)
  if (typeof window !== "undefined") return "";
  return "http://localhost:3001";
};

export const bridgeUrl = (path: string): string => {
  const base = getBridgeUrl();
  return base ? `${base}${path}` : path;
};
