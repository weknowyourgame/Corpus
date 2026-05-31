# Roblox Open Source Game Knowledge Base Plan

Goal: create a persistent knowledge base of open-source Roblox games so Stud can retrieve examples by game niche, systems, mechanics, and script patterns before it modifies a connected Roblox Studio project.

Authority order:
1. Live connected Studio project
2. Current project/session script index
3. Official Roblox docs
4. Curated open-source Roblox game corpus

## Architecture

```
Game files (raw .lua/.luau) uploaded to R2
        |
        v
Cron Job (Cloudflare Worker or server-side)
        |
        +--> Chunk scripts (summary / system / script)
        +--> Embed chunks via Workers AI
        +--> Upsert vectors into niche-specific Vectorize indexes
        +--> Store chunk metadata in Postgres (Prisma)
        +--> Store raw chunks in R2

Stud server/agent/rag.ts
        |
        +--> live Studio in-memory retrieval
        +--> official docs retrieval
        +--> corpus retrieval (retrieve.ts)
                |
                v
        <roblox_retrieved_context>
```

## Vectorize Index Strategy

Indexes are organized by **game niche** not chunk type.

Each niche gets its own Vectorize index. All chunk types (summary, system, script) for games in that niche go into the same index.

### Supported Niches

| Index Name | Niche |
|------------|-------|
| `roblox-tower-defense` | Tower defense games |
| `roblox-fps` | First-person shooters, combat games |
| `roblox-obby` | Obstacle courses, parkour |
| `roblox-rpg` | RPGs, adventure games |
| `roblox-simulator` | Simulator games (pet sim, mining sim, etc.) |
| `roblox-tycoon` | Tycoon, base-building games |
| `roblox-battle-royale` | Battle royale, last-man-standing |
| `roblox-horror` | Horror, escape room games |
| `roblox-racing` | Racing, vehicle games |
| `roblox-social` | Social hangout, roleplay games |

New indexes can be added per niche as more games are ingested. Each index uses **768 dimensions, cosine distance** (`@cf/baai/bge-base-en-v1.5`).

## R2 Structure

```
roblox-games/
  {game-slug}/
    raw/              ← original .lua/.luau files
    chunks/           ← processed chunk .txt files
    summaries/        ← game-level summary markdown
```

## Postgres Schema (Prisma)

```prisma
model Game {
  id          String   @id @default(uuid())
  slug        String   @unique
  name        String
  niche       String                    ← matches index name suffix (e.g. "tower-defense")
  subniches   String[] @default([])
  genre       String?
  mechanics   String[] @default([])
  services    String[] @default([])
  scriptCount Int      @default(0)
  r2Prefix    String
  summaryText String?
  qualityScore Float   @default(0.5)
  ingestedAt  DateTime @default(now())
  chunks      Chunk[]
}

model Chunk {
  id             String  @id @default(uuid())
  gameId         String
  game           Game    @relation(fields: [gameId], references: [id], onDelete: Cascade)
  chunkType      String  ← "summary" | "system" | "script"
  vectorizeIndex String  ← which niche index this chunk went into
  vectorizeId    String  @unique
  r2Path         String
  title          String?
  systemName     String?
  filePath       String?
  robloxPath     String?
  scriptType     String? ← "server" | "client" | "module" | "shared"
  lineStart      Int?
  lineEnd        Int?
  symbols        String[] @default([])
  services       String[] @default([])
  remotes        String[] @default([])
  tags           String[] @default([])
  qualityScore   Float   @default(0.5)
  sourceHash     String?
  createdAt      DateTime @default(now())
}
```

## Cron Job — Ingestion

Runs on a schedule (or triggered manually). Processes any game in R2 that hasn't been fully chunked yet.

Steps per game:
1. List `.lua`/`.luau` files under `{game-slug}/raw/` in R2
2. If `default.project.json` exists, map filesystem paths to Roblox instance paths
3. Infer script type: `Script` → server, `LocalScript` → client, `ModuleScript` → module
4. Extract metadata: services, `require()` calls, remotes, functions, DataStore names
5. Generate chunks: one game summary + system chunks + one chunk per script
6. Upload chunks to R2 under `{game-slug}/chunks/`
7. Embed each chunk via Workers AI
8. Upsert vectors into the game's niche Vectorize index
9. Insert/update game + chunk rows in Postgres
10. Mark game as fully ingested

Idempotent by `slug` + `sourceHash` — re-running never duplicates.

## Retrieval Strategy

Called once per agent run on iteration 1 via `retrieve.ts`.

```
1. Detect niche from user query
   → keyword match or LLM classification
   → determines which Vectorize index to search

2. Embed user query via Workers AI

3. Search the matched niche index
   → topK 10-15 results

4. Also search a global cross-niche index (roblox-general) if confidence is low
   → topK 5

5. Resolve vectorize_id → Postgres → get r2_path + metadata

6. Fetch chunk content from R2

7. Re-rank by:
   → vector similarity score
   → quality_score
   → exact service/symbol match boost
   → prefer system chunks over raw script chunks for architecture questions
   → prefer script chunks for "how do I implement X" questions

8. Dedupe by sourceHash

9. Budget cap: CORPUS_MAX_CHUNKS=8, CORPUS_CONTEXT_MAX_CHARS=12000

10. Return as structured CorpusRetrievalResult
```

## RAG Integration

`rag.ts` injects corpus results as:

```
[Open-source Roblox corpus examples]
game: Flood Escape Inspired
niche: obby
quality_score: 0.82
chunk_type: system
path: game.ServerScriptService.RoundManager
reason: matched "round timer", "obby"
```luau
...
```
```

Authority label is always shown. Corpus never overrides live project state.

## Config

```env
CORPUS_ENABLED=false
CORPUS_MAX_CHUNKS=8
CORPUS_CONTEXT_MAX_CHARS=12000
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_R2_BUCKET=roblox-games
CLOUDFLARE_WORKERS_AI_EMBED_MODEL=@cf/baai/bge-base-en-v1.5
DATABASE_URL=
```

Niche index names are derived from the `niche` field on each game — no static list of env vars per index.

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Architecture decisions | ✅ Done |
| 1 | Corpus config (`corpus/config.ts`) | ✅ Done |
| 2 | Prisma schema | ✅ Done (needs update for niche-based model) |
| 3 | Cloudflare resource setup commands | ✅ Done (needs update for niche indexes) |
| 4 | Cron ingestion job | ❌ Next |
| 5 | `retrieve.ts` — niche detection + Vectorize search + R2 fetch + re-rank | ❌ Next |
| 6 | `rag.ts` async update — corpus block injection | ❌ Next |
| 7 | `runtime.ts` — await async RAG on iteration 1 | ❌ Next |
| 8 | Tests | ❌ Next |
| 9 | System prompt corpus policy | ❌ Next |
| 10 | Admin UI | ❌ Later |
