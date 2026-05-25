const BASE = "https://apis.roblox.com/cloud/v2";

export const REDACT_SIZE = 500;

export function redactValue(value: string): string {
  if (value.length > REDACT_SIZE) return `[REDACTED: ${value.length} chars]`;
  return value;
}

export class OpenCloudClient {
  private readonly apiKey: string;
  readonly universeId: string;

  constructor() {
    this.apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY ?? "";
    this.universeId = process.env.ROBLOX_UNIVERSE_ID ?? "";
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.universeId);
  }

  private async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.apiKey);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...init, headers, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Open Cloud HTTP ${response.status}: ${text}`);
    }
    return response;
  }

  async listStores(signal?: AbortSignal): Promise<string[]> {
    const url = `${BASE}/universes/${this.universeId}/data-stores`;
    const response = await this.request(url, {}, signal);
    const body = await response.json() as { dataStores?: Array<{ name: string }> };
    return (body.dataStores ?? []).map((s) => s.name);
  }

  async listKeys(store: string, scope: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    const params = new URLSearchParams({
      dataStoreName: store,
      scope,
      limit: String(Math.min(limit, 100)),
    });
    const url = `${BASE}/universes/${this.universeId}/data-stores/entries?${params}`;
    const response = await this.request(url, {}, signal);
    const body = await response.json() as { keys?: Array<{ key: string }> };
    return (body.keys ?? []).map((k) => k.key);
  }

  async readKey(store: string, scope: string, key: string, signal?: AbortSignal): Promise<{ value: string | null; version?: string }> {
    const params = new URLSearchParams({ dataStoreName: store, scope });
    const url = `${BASE}/universes/${this.universeId}/data-stores/entries/entry?${params}&entryKey=${encodeURIComponent(key)}`;
    const response = await this.request(url, {}, signal).catch((err: Error) => {
      if (err.message.includes("HTTP 404")) return null;
      throw err;
    });
    if (!response) return { value: null };
    const version = response.headers.get("roblox-entry-version") ?? undefined;
    const text = await response.text();
    return { value: text, version };
  }

  async writeKey(store: string, scope: string, key: string, value: string, signal?: AbortSignal): Promise<{ version: string }> {
    const params = new URLSearchParams({ dataStoreName: store, scope });
    const url = `${BASE}/universes/${this.universeId}/data-stores/entries/entry?${params}&entryKey=${encodeURIComponent(key)}`;
    const response = await this.request(url, { method: "POST", body: value }, signal);
    const version = response.headers.get("roblox-entry-version") ?? "";
    return { version };
  }

  async deleteKey(store: string, scope: string, key: string, signal?: AbortSignal): Promise<void> {
    const params = new URLSearchParams({ dataStoreName: store, scope });
    const url = `${BASE}/universes/${this.universeId}/data-stores/entries/entry?${params}&entryKey=${encodeURIComponent(key)}`;
    await this.request(url, { method: "DELETE" }, signal);
  }

  async incrementKey(store: string, scope: string, key: string, delta: number, signal?: AbortSignal): Promise<{ value: number }> {
    const params = new URLSearchParams({ dataStoreName: store, scope });
    const url = `${BASE}/universes/${this.universeId}/data-stores/entries/entry:increment?${params}&entryKey=${encodeURIComponent(key)}&incrementBy=${delta}`;
    const response = await this.request(url, { method: "POST" }, signal);
    const text = await response.text();
    return { value: Number(text) };
  }
}
