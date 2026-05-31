/**
 * test-vectorize.ts — Cloudflare Workers AI + Vectorize diagnostic.
 * Run: bun run scripts/test-vectorize.ts
 */

const accountId  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const apiToken   = process.env.CLOUDFLARE_API_TOKEN!;
const embedModel = process.env.CLOUDFLARE_WORKERS_AI_EMBED_MODEL ?? "@cf/baai/bge-base-en-v1.5";
const INDEX      = process.env.CLOUDFLARE_VECTORIZE_TEST_INDEX ?? "roblox-horror";

if (!accountId || !apiToken) { console.error("Missing env vars"); process.exit(1); }

const CF     = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const sleep  = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hdr    = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
const hdrNDJ = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/x-ndjson" };

type EmbedResponse = { result: { data: number[][] } };
type VectorizeMatch = { id: string; score: number; metadata?: Record<string, string | number | boolean> };
type QueryResponse = { result?: { matches?: VectorizeMatch[] } };

async function cfFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${CF}${path}`, init);
  const text = await res.text();
  return { res, text };
}

function printFailure(label: string, status: number, body: string): never {
  console.error(`${label} failed: ${status} ${body}`);
  if (body.includes("Unable to authenticate request")) {
    console.error("\nYour token is valid enough for Workers AI only if step 1 passed, but it is not authorized for this Vectorize route/account.");
    console.error("Fix: create/use a Cloudflare API token with Account > Vectorize:Edit for this account, plus Workers AI:Read/Edit for embedding.");
  }
  process.exit(1);
}

// 1. Embed
console.log("1. Embedding...");
const { res: eRes, text: eBody } = await cfFetch(`/ai/run/${embedModel}`, {
  method: "POST",
  headers: hdr,
  body: JSON.stringify({ text: "horror game combat DataStore" }),
});
if (!eRes.ok) printFailure("Embed", eRes.status, eBody);
const vector: number[] = (JSON.parse(eBody) as EmbedResponse).result.data[0];
console.log(`   ✓ ${vector.length} dims`);

// 2. Check index/account/token before writing.
console.log(`\n2. Checking index ${INDEX}...`);
const { res: iRes, text: iBody } = await cfFetch(`/vectorize/v2/indexes/${INDEX}`, { headers: hdr });
console.log(`   Status: ${iRes.status}  Body: ${iBody}`);
if (!iRes.ok) printFailure("Index check", iRes.status, iBody);

// 3. Upsert
const testId = `diag-${Date.now()}`;
console.log(`\n3. Upserting id=${testId} via Vectorize V2...`);
const { res: uRes, text: uBody } = await cfFetch(`/vectorize/v2/indexes/${INDEX}/upsert`, {
  method: "POST",
  headers: hdrNDJ,
  body: JSON.stringify({ id: testId, values: vector, metadata: { test: "true" } }),
});
console.log(`   Status: ${uRes.status}  Body: ${uBody}`);
if (!uRes.ok) printFailure("Upsert", uRes.status, uBody);

console.log("   Waiting 5s for the async mutation to become queryable...");
await sleep(5000);

// 4. get_by_ids (underscore per CF docs)
console.log(`\n4. get_by_ids check...`);
const { res: gbRes, text: gbBody } = await cfFetch(`/vectorize/v2/indexes/${INDEX}/get_by_ids`, {
  method: "POST",
  headers: hdr,
  body: JSON.stringify({ ids: [testId] }),
});
console.log(`   Status: ${gbRes.status}  Body: ${gbBody}`);

// 5. Query
console.log(`\n5. Query...`);
const { res: qRes, text: qBody } = await cfFetch(`/vectorize/v2/indexes/${INDEX}/query`, {
  method: "POST",
  headers: hdr,
  body: JSON.stringify({ vector, topK: 3, returnMetadata: "all" }),
});
console.log(`   Status: ${qRes.status}  Body: ${qBody}`);
if (!qRes.ok) printFailure("Query", qRes.status, qBody);
const matches = (JSON.parse(qBody) as QueryResponse).result?.matches ?? [];
console.log(`\n${matches.length > 0 ? "✓ SUCCESS" : "✗ FAIL"} — ${matches.length} matches`);

// 6. Cleanup diagnostic vector
console.log(`\n6. Cleaning diagnostic vector...`);
const cleanupIds = [...new Set([
  testId,
  ...matches
    .filter((match) => match.metadata?.test === "true")
    .map((match) => match.id),
])];
const { res: dRes, text: dBody } = await cfFetch(`/vectorize/v2/indexes/${INDEX}/delete_by_ids`, {
  method: "POST",
  headers: hdr,
  body: JSON.stringify({ ids: cleanupIds }),
});
console.log(`   Status: ${dRes.status}  Body: ${dBody}`);
console.log(`   Deleted ids: ${cleanupIds.join(", ")}`);
