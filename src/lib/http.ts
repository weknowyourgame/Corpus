/**
 * HTTP helpers for the web app (replaces Tauri HTTP plugin).
 */

import { bridgeUrl } from "@/lib/bridge/config";

const PROXY_PREFIXES = [
  "https://models.dev/",
  "https://catalog.roblox.com/",
  "https://thumbnails.roblox.com/",
  "https://apis.roblox.com/",
];

/** Fetch with CORS proxy for whitelisted external APIs */
export const proxiedFetch = (url: string, init?: RequestInit): Promise<Response> => {
  const needsProxy = PROXY_PREFIXES.some((p) => url.startsWith(p));
  if (!needsProxy) return fetch(url, init);
  const proxy = bridgeUrl(`/api/proxy?url=${encodeURIComponent(url)}`);
  return fetch(proxy, init);
};
