const BASE = "https://apis.roblox.com/cloud/v2";

export const REDACT_SIZE = 500;

export type Environment = "development" | "staging" | "production";

const SENSITIVE_KEY = /^(?:password|passwd|secret|token|api[_-]?key|authorization|auth|access[_-]?token|refresh[_-]?token|private[_-]?key|cookie|session|cvv|cardnumber|card[_-]?number|ssn|email)$/i;
const TOKEN_LIKE = /\b(?:eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,}|rbx[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})\b/g;
const EMAIL_LIKE = /\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;

function redactPatterns(value: string): string {
  return value.replace(TOKEN_LIKE, "[REDACTED:token]").replace(EMAIL_LIKE, "[REDACTED:email]");
}

function redactJsonShape(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactPatterns(value) : value;
  }
  if (Array.isArray(value)) return value.map(redactJsonShape);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = redactJsonShape(v);
  }
  return out;
}

export function redactValue(value: string): string {
  if (typeof value !== "string") return String(value);
  if (value.length > REDACT_SIZE) return `[REDACTED: ${value.length} chars]`;
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      const cleaned = redactJsonShape(parsed);
      const serialized = JSON.stringify(cleaned);
      return serialized.length > REDACT_SIZE ? `[REDACTED: ${value.length} chars]` : serialized;
    } catch {
      // not JSON; fall through to string redaction
    }
  }
  return redactPatterns(value);
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
      // Strip any echoed credential header before raising.
      const safeText = text.replace(this.apiKey || "__unset_key__", "[REDACTED]");
      throw new OpenCloudError(response.status, safeText);
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
      if (err instanceof OpenCloudError && err.status === 404) return null;
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

export class OpenCloudError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Open Cloud HTTP ${status}: ${body}`);
    this.name = "OpenCloudError";
  }
}
