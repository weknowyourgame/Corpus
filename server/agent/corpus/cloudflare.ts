import type { CorpusConfig } from "./config.ts";
import type { VectorRecord, VectorMatch } from "./types.ts";

const cfBase = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export async function embed(text: string, config: CorpusConfig): Promise<number[]> {
  const url = `${cfBase(config.cloudflare.accountId)}/ai/run/${config.cloudflare.workersAiEmbedModel}`;
  const res = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(config.cloudflare.apiToken),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Workers AI embed failed ${res.status}: ${await res.text()}`);
  const json = await res.json() as { result: { data: number[][] } };
  return json.result.data[0];
}

export async function upsertVectors(
  indexName: string,
  vectors: VectorRecord[],
  config: CorpusConfig,
): Promise<void> {
  if (!vectors.length) return;
  const url = `${cfBase(config.cloudflare.accountId)}/vectorize/v2/indexes/${indexName}/upsert`;
  const ndjson = vectors.map((v) => JSON.stringify({
    id: v.id,
    values: v.values,
    metadata: v.metadata,
  })).join("\n");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.cloudflare.apiToken}`,
      "Content-Type": "application/x-ndjson",
    },
    body: ndjson,
  });
  if (!res.ok) throw new Error(`Vectorize upsert failed ${res.status}: ${await res.text()}`);
}

export async function queryVectors(
  indexName: string,
  vector: number[],
  topK: number,
  config: CorpusConfig,
): Promise<VectorMatch[]> {
  const url = `${cfBase(config.cloudflare.accountId)}/vectorize/v2/indexes/${indexName}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(config.cloudflare.apiToken),
    body: JSON.stringify({ vector, topK, returnMetadata: "all" }),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Vectorize query failed ${res.status}: ${await res.text()}`);
  const json = await res.json() as {
    result: { matches: Array<{ id: string; score: number; metadata?: Record<string, string | number | boolean> }> };
  };
  return json.result.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata ?? {} }));
}

export async function createVectorizeIndex(indexName: string, config: CorpusConfig): Promise<void> {
  const url = `${cfBase(config.cloudflare.accountId)}/vectorize/v2/indexes`;
  const res = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(config.cloudflare.apiToken),
    body: JSON.stringify({ name: indexName, config: { dimensions: 768, metric: "cosine" } }),
  });
  if (res.status === 409) return;
  if (!res.ok) throw new Error(`Vectorize create failed ${res.status}: ${await res.text()}`);
}

export async function putR2Object(key: string, content: string, config: CorpusConfig): Promise<void> {
  const url = `${cfBase(config.cloudflare.accountId)}/r2/buckets/${config.cloudflare.r2Bucket}/objects/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.cloudflare.apiToken}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: content,
  });
  if (!res.ok) throw new Error(`R2 put failed for ${key}: ${res.status} ${await res.text()}`);
}

export async function getR2Object(key: string, config: CorpusConfig): Promise<string | null> {
  const url = `${cfBase(config.cloudflare.accountId)}/r2/buckets/${config.cloudflare.r2Bucket}/objects/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.cloudflare.apiToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed for ${key}: ${res.status} ${await res.text()}`);
  return res.text();
}
