# Roblox Open Source Game Knowledge Base Plan

This document turns the generic Cloudflare AI stack idea into a Stud-specific build plan.

Goal: create a persistent knowledge base of open-source Roblox games so Stud can retrieve examples by game style, systems, mechanics, services, script patterns, architecture, and implementation quality before it modifies a connected Roblox Studio project.

The important product rule is authority order:

1. Live connected Studio project
2. Current project/session script index
3. Official Roblox docs
4. Curated open-source Roblox game corpus

The corpus should inspire and provide reference implementations. It must not override the user's live project architecture or blindly copy low-quality code.

## Current Codebase Fit

Stud already has the right place to attach this:

- `server/agent/runtime.ts` builds per-run context on iteration 1.
- `server/agent/rag.ts` creates the retrieved context block.
- `server/agent/retrieval.ts` indexes live Studio scripts in memory.
- `server/agent/docs.ts` retrieves local Roblox API reference snippets.
- `server/agent/system-prompt.ts` tells the model to execute through Studio tools instead of outputting code blocks.
- `server/index.js` owns server startup, tool registry composition, routes, Open Cloud tools, and the Studio relay.
- React chat UI already talks to the server-side agent through `src/lib/ai/server-agent.ts`.

So this should be implemented as a server-side corpus retrieval layer first, not as a frontend feature. The UI can come later for corpus admin and debug views.

## Target Architecture

```text
Open-source game repos/zips
        |
        v
Ingestion CLI or Worker
        |
        +--> Cloudflare R2
        |       raw source, normalized scripts, summaries, extracted pattern files
        |
        +--> Postgres via Hyperdrive
        |       games, scripts, chunks, systems, patterns, quality metadata
        |
        +--> Workers AI
        |       summaries and embeddings
        |
        +--> Vectorize
                game summaries, systems, scripts, patterns

Stud server/agent/rag.ts
        |
        +--> live Studio in-memory retrieval
        +--> official docs retrieval
        +--> corpus retrieval API/SDK
        |
        v
<roblox_retrieved_context>
```

## Phase 0: Decisions And Guardrails

1. Decide corpus source format support for v1.
   Start with filesystem/Rojo-style projects containing `.lua`, `.luau`, and optional `default.project.json`.
   Defer `.rbxl`, `.rbxm`, `.rbxlx`, and `.rbxmx` import until v2 unless you already have reliable exporters.

2. Decide where ingestion runs.
   Recommended v1: local Node/Bun CLI in this repo that uploads to Cloudflare.
   Reason: easier debugging, easier fixture testing, easier parsing of local open-source repos.
   Later: add R2-triggered Cloudflare Workers for hosted ingestion.

3. Decide quality and license policy.
   Store `source_url`, `license`, `license_status`, `trust_level`, and `quality_score`.
   Do not retrieve chunks whose license is unknown unless explicitly allowed by config.

4. Keep corpus retrieval read-only.
   Corpus data never creates Studio changes by itself.
   It only enters the model as labeled context.

5. Do not use Cloudflare AI Search as the first implementation dependency.
   Build direct Vectorize plus Postgres lookup first. Add AI Search later if it clearly reduces maintenance.

## Phase 1: Add Configuration

Create `server/agent/corpus/config.ts`.

Environment variables:

```text
CORPUS_ENABLED=false
CORPUS_ALLOW_UNKNOWN_LICENSE=false
CORPUS_MAX_CHUNKS=8
CORPUS_CONTEXT_MAX_CHARS=12000
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_R2_BUCKET=roblox-games
CLOUDFLARE_VECTORIZE_GAME_INDEX=roblox-game-summaries
CLOUDFLARE_VECTORIZE_SYSTEM_INDEX=roblox-systems
CLOUDFLARE_VECTORIZE_SCRIPT_INDEX=roblox-scripts
CLOUDFLARE_VECTORIZE_PATTERN_INDEX=roblox-patterns
CLOUDFLARE_WORKERS_AI_EMBED_MODEL=@cf/baai/bge-base-en-v1.5
DATABASE_URL=
```

Update `.env.example` with placeholders and comments. Keep corpus disabled by default so current development does not require Cloudflare credentials.

Acceptance criteria:

- Server starts with corpus disabled.
- Missing Cloudflare/Postgres credentials never break normal Studio usage.
- Config parser has tests for enabled/disabled states.

## Phase 2: Database Schema

Create `server/agent/corpus/schema.sql` or a migration folder if one exists later.

Use these tables:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  source_url TEXT,
  license TEXT,
  license_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (license_status IN ('approved','unknown','blocked')),
  trust_level TEXT NOT NULL DEFAULT 'open_source'
    CHECK (trust_level IN ('live_project','curated','open_source','unknown')),
  genre TEXT,
  subgenres TEXT[] DEFAULT '{}',
  complexity TEXT CHECK (complexity IN ('beginner','intermediate','advanced')),
  player_mode TEXT CHECK (player_mode IN ('solo','multiplayer','both')),
  mechanics TEXT[] DEFAULT '{}',
  services TEXT[] DEFAULT '{}',
  frameworks TEXT[] DEFAULT '{}',
  script_count INTEGER DEFAULT 0,
  r2_prefix TEXT NOT NULL,
  summary_text TEXT,
  quality_score REAL DEFAULT 0.5,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL CHECK (chunk_type IN ('summary','system','script','pattern')),
  vectorize_index TEXT NOT NULL,
  vectorize_id TEXT UNIQUE NOT NULL,
  r2_path TEXT NOT NULL,
  title TEXT,
  system_name TEXT,
  system_type TEXT,
  file_path TEXT,
  roblox_path TEXT,
  script_type TEXT CHECK (script_type IN ('server','client','module','shared','unknown')),
  line_start INTEGER,
  line_end INTEGER,
  line_count INTEGER,
  symbols TEXT[] DEFAULT '{}',
  required_modules TEXT[] DEFAULT '{}',
  remotes TEXT[] DEFAULT '{}',
  services TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  quality_score REAL DEFAULT 0.5,
  source_hash TEXT,
  duplicate_cluster_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  category TEXT,
  difficulty TEXT CHECK (difficulty IN ('beginner','intermediate','advanced')),
  vectorize_id TEXT UNIQUE NOT NULL,
  r2_path TEXT NOT NULL,
  description TEXT,
  services TEXT[] DEFAULT '{}',
  appears_in_count INTEGER DEFAULT 0,
  quality_score REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pattern_games (
  pattern_id UUID REFERENCES patterns(id) ON DELETE CASCADE,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY (pattern_id, game_id)
);

CREATE INDEX idx_games_genre ON games(genre);
CREATE INDEX idx_games_mechanics ON games USING gin(mechanics);
CREATE INDEX idx_games_services ON games USING gin(services);
CREATE INDEX idx_chunks_game_id ON chunks(game_id);
CREATE INDEX idx_chunks_type ON chunks(chunk_type);
CREATE INDEX idx_chunks_vectorize_id ON chunks(vectorize_id);
CREATE INDEX idx_chunks_services ON chunks USING gin(services);
CREATE INDEX idx_chunks_symbols ON chunks USING gin(symbols);
CREATE INDEX idx_chunks_remotes ON chunks USING gin(remotes);
```

Acceptance criteria:

- Migration can run against local Postgres and the hosted Postgres provider.
- `vectorize_id` maps every vector result back to full R2 content.
- Arrays support service, mechanic, symbol, and remote filtering.

## Phase 3: Create Cloudflare Resources

Create four Vectorize indexes with 768 dimensions and cosine distance:

```bash
wrangler vectorize create roblox-game-summaries --dimensions=768 --metric=cosine
wrangler vectorize create roblox-systems --dimensions=768 --metric=cosine
wrangler vectorize create roblox-scripts --dimensions=768 --metric=cosine
wrangler vectorize create roblox-patterns --dimensions=768 --metric=cosine
```

Create an R2 bucket:

```bash
wrangler r2 bucket create roblox-games
```

Set up Postgres through Supabase, Neon, Railway, or another provider, then configure Hyperdrive when moving ingestion/query to Workers.

Acceptance criteria:

- A smoke test can embed one string, upsert one vector, query it, and fetch the referenced R2 object.
- Index names match `.env.example`.

## Phase 4: Build The Local Ingestion CLI

Create:

```text
server/agent/corpus/
  config.ts
  types.ts
  extract.ts
  chunk.ts
  analyze.ts
  cloudflare.ts
  postgres.ts
  ingest.ts
  retrieve.ts
  format.ts
```

Add script to `package.json`:

```json
"corpus:ingest": "tsx server/agent/corpus/ingest.ts"
```

CLI usage:

```bash
npm run corpus:ingest -- --game ./path/to/game --name "Flood Escape Inspired" --source-url "https://github.com/..." --license MIT --genre obstacle_course
```

Implementation steps:

1. Walk source folder and collect `.lua` and `.luau` files.
2. If `default.project.json` exists, map filesystem paths to Roblox instance paths.
3. Infer script type:
   `Script` -> server, `LocalScript` -> client, `ModuleScript` -> module/shared.
4. Extract metadata:
   Roblox services, `require(...)` calls, remotes, functions, table methods, DataStore names, TweenService usage, CollectionService tags.
5. Generate chunk types:
   summary, system, script, pattern candidates.
6. Upload raw and normalized files to R2:
   `games/{slug}/raw/...`
   `games/{slug}/chunks/{chunk-id}.txt`
   `games/{slug}/summaries/game-summary.md`
7. Generate embeddings with Workers AI.
8. Upsert vectors into the right Vectorize indexes.
9. Insert game and chunk rows into Postgres.

Acceptance criteria:

- Ingesting one fixture game produces one game row and at least one script chunk.
- Re-ingesting the same game is idempotent by `slug` and `source_hash`.
- Failed embedding/upsert does not leave misleading complete metadata.
- CLI prints a small ingestion report: files read, chunks created, vectors upserted, warnings.

## Phase 5: Chunking Rules

Use these chunk types:

### Game Summary Chunk

One per game.

Content:

- genre
- mechanics
- core loop
- architecture style
- service usage
- networking model
- persistence model
- UI approach
- complexity
- warnings or questionable patterns

Vectorize index: `roblox-game-summaries`

### System Chunks

Five to fifteen per medium game.

Group scripts by:

- service folder, for example `ServerScriptService/Combat`
- naming patterns, for example `ShopService`, `ShopController`, `ShopUI`
- service usage, for example DataStore/ProfileService scripts
- remote relationships, for example client shop UI plus server purchase handler

System types:

- combat
- inventory
- shop
- ui
- persistence
- networking
- npc_ai
- physics
- round_loop
- economy
- building
- admin
- matchmaking
- unknown

Vectorize index: `roblox-systems`

### Script Chunks

One per normal script file in v1.

For huge scripts, split by semantic units later:

- top-level functions
- module public API sections
- event handlers
- remote handlers

Vectorize index: `roblox-scripts`

### Pattern Chunks

Distilled examples across games.

Examples:

- `datastore_save_load`
- `remote_event_purchase_validation`
- `client_ui_controller`
- `round_timer_state_machine`
- `tween_part_motion`
- `leaderstats_setup`
- `server_authoritative_damage`

Vectorize index: `roblox-patterns`

Acceptance criteria:

- Chunks include enough header context to be useful alone.
- Chunks store source path, Roblox path, run side, services, symbols, remotes, and line ranges when available.
- Low-quality or unsafe examples are tagged and downranked.

## Phase 6: Corpus Retrieval Client

Create `server/agent/corpus/retrieve.ts`.

Public API:

```ts
export async function retrieveCorpusContext(input: {
  query: string;
  maxChunks?: number;
  signal?: AbortSignal;
}): Promise<CorpusRetrievalResult>;
```

The retrieval flow:

1. Return empty result immediately when `CORPUS_ENABLED !== "true"`.
2. Embed the user query with Workers AI.
3. Search Vectorize indexes in parallel:
   - summaries: topK 3
   - systems: topK 5
   - scripts: topK 8
   - patterns: topK 5
4. Apply metadata filters when inferable from query:
   - genre
   - mechanic
   - service
   - script type
   - complexity
5. Merge and deduplicate by `duplicate_cluster_id`, `source_hash`, and `vectorize_id`.
6. Use Postgres to resolve `vectorize_id` to `r2_path` and metadata.
7. Fetch chunk contents from R2.
8. Rank final chunks:
   live project not included here, but corpus chunks should be ranked by vector score, trust, quality, license, exact service/symbol match, and non-duplication.

Acceptance criteria:

- Querying "tower defense shop system" returns shop/economy/round-loop examples when present.
- Querying "DataStore save load" returns persistence patterns before unrelated game summaries.
- Network failures return empty corpus context plus a warning log, not a broken chat run.

## Phase 7: Integrate With Existing RAG

Modify `server/agent/rag.ts`:

- keep `buildRagContext(...)` or add an async version, for example `buildRagContextAsync(...)`
- retrieve live Studio chunks first
- retrieve docs next
- retrieve corpus chunks last
- format all context into the existing XML-like block

Example format:

```text
<roblox_retrieved_context>
Authority order: live project > official docs > curated open-source corpus.

[Live Studio project scripts]
...

[Roblox API reference]
...

[Open-source Roblox corpus examples]
source_type: open_source_corpus
game: Tower Defense Kit
license: MIT
trust_level: open_source
quality_score: 0.82
chunk_type: system
system_type: shop
path: game.ServerScriptService.ShopService
reason: matched "tower defense", "shop", "server purchase validation"
```luau
...
```
</roblox_retrieved_context>
```

Modify `server/agent/runtime.ts` so iteration 1 awaits the async RAG builder before calling the model.

Acceptance criteria:

- Existing tests pass with corpus disabled.
- New tests verify corpus context appears only when enabled and available.
- The prompt clearly labels corpus as examples, not live project truth.

## Phase 8: Add Tests

Add tests:

```text
server/agent/corpus/extract.test.ts
server/agent/corpus/chunk.test.ts
server/agent/corpus/format.test.ts
server/agent/corpus/retrieve.test.ts
server/agent/rag-corpus.test.ts
```

Test cases:

- Rojo path mapping from `default.project.json`.
- service extraction: `game:GetService("DataStoreService")`, `TweenService`, `RunService`
- remote extraction: `RemoteEvent`, `RemoteFunction`, `FireServer`, `OnServerEvent`
- script type inference for server/client/module/shared
- duplicate source hash handling
- corpus disabled returns no external calls
- retrieval formatter respects max character budget
- unsafe client-authoritative money/combat examples get warning metadata

Acceptance criteria:

- `npm run typecheck` passes.
- `npm test -- corpus` passes.
- No tests require real Cloudflare credentials; use mocked clients.

## Phase 9: Query-Time Prompt Policy

Update `server/agent/system-prompt.ts` only if needed. The existing prompt is already strict about tool execution.

Add policy language like:

```text
Open-source corpus examples are reference material only. Prefer the connected Studio project's architecture. Do not copy corpus code blindly. If a corpus example conflicts with server-authoritative Roblox security, adapt it safely.
```

Do not tell the model to output "complete working Lua code only" in chat. In Stud, the model must write code into Studio through tools.

Acceptance criteria:

- Model still uses `mcp__roblox_studio__create_instance` and `mcp__roblox_studio__write_script`.
- Corpus examples improve implementation choices without causing paste-only code responses.

## Phase 10: Optional Admin UI

After server retrieval works, add a small admin/debug UI.

Possible frontend files:

- `src/components/settings/SettingsDialog.tsx`
- `src/stores/settings.ts`
- new `src/components/settings/CorpusSettings.tsx`

Server routes:

- `GET /agent/corpus/status`
- `POST /agent/corpus/search-preview`
- `GET /agent/corpus/games`

UI should show:

- corpus enabled/disabled
- index counts if available
- last ingestion time
- search preview for a query
- retrieved chunk provenance

Acceptance criteria:

- User can debug why a prompt retrieved certain examples.
- Admin UI is optional and does not block core RAG behavior.

## Phase 11: Hosted Worker Ingestion

Once local ingestion is reliable, port ingestion to Cloudflare Workers.

Worker bindings:

```toml
[[r2_buckets]]
binding = "ROBLOX_GAMES"
bucket_name = "roblox-games"

[[vectorize]]
binding = "GAME_SUMMARIES"
index_name = "roblox-game-summaries"

[[vectorize]]
binding = "SYSTEMS"
index_name = "roblox-systems"

[[vectorize]]
binding = "SCRIPTS"
index_name = "roblox-scripts"

[[vectorize]]
binding = "PATTERNS"
index_name = "roblox-patterns"

[[hyperdrive]]
binding = "DB"
id = "<hyperdrive-id>"

[ai]
binding = "AI"
```

Worker endpoints:

- `POST /ingest/start`
- `GET /ingest/:jobId`
- `POST /query`

Acceptance criteria:

- Local CLI and Worker share chunking/analyzer code where possible.
- Worker jobs are resumable for large game repositories.
- Vectorize upserts are batched.

## Rollout Order

Week 1:

- Add config, schema, and mocked Cloudflare/Postgres clients.
- Build extractor and chunker with fixture games.
- Add tests.

Week 2:

- Implement local ingestion CLI.
- Ingest 3 to 5 open-source games.
- Inspect chunks manually and tune metadata.

Week 3:

- Implement corpus retrieval client.
- Integrate async retrieval into `server/agent/rag.ts` and `server/agent/runtime.ts`.
- Add formatter and context budget tests.

Week 4:

- Ingest 25 to 50 games.
- Test prompts like:
  - "Build a tower defense game with a shop system"
  - "Add a round timer and intermission loop"
  - "Make a server-authoritative sword combat system"
  - "Use DataStore safely for coins"

Week 5:

- Add search preview route or admin UI.
- Add quality scoring improvements and duplicate clustering.

Week 6:

- Move ingestion/query pieces to Cloudflare Workers if local server retrieval is stable.
- Add monitoring, ingestion reports, and corpus refresh jobs.

## Definition Of Done

The first usable version is done when:

- At least 10 games are ingested.
- Each game has summary, script, and at least some system chunks.
- Query-time RAG returns corpus context for relevant prompts.
- Corpus retrieval is disabled safely by default.
- Live Studio context remains higher authority than corpus examples.
- Tests cover extraction, chunking, formatting, and disabled retrieval.
- A real prompt like "Build a tower defense game with a shop system" causes Stud to create or modify Studio instances through tools, with corpus examples only used as background context.

## Build Prompt

Use this prompt to ask an implementation agent to build the plan in this repository:

```text
You are working in /Users/sarthakkapila/stud, the Stud repo. Stud is a React + Vite + shadcn UI frontend with an Express/Bun bridge and a server-side Roblox agent runtime under server/agent. The goal is to add a persistent open-source Roblox game corpus knowledge base using Cloudflare R2, Workers AI embeddings, Vectorize, and Postgres metadata, while preserving the current live Studio tool-execution behavior.

Read AGENTS.md first and follow the repo style. Do not co-author commits. Prefer const, early returns, narrow changes, and tests.

Implement the plan in knowledge-base/ROBLOX_OPEN_SOURCE_GAME_KNOWLEDGE_BASE_PLAN.md in small, safe phases:

1. Add corpus config under server/agent/corpus/config.ts and update .env.example. Corpus must be disabled by default and never break normal Studio use when credentials are missing.
2. Add schema.sql for Postgres metadata under server/agent/corpus/schema.sql.
3. Add types, extraction, chunking, analysis, formatting, and mocked client boundaries under server/agent/corpus/.
4. Add a local ingestion CLI at server/agent/corpus/ingest.ts and package.json script corpus:ingest. Start with filesystem/Rojo-style .lua/.luau projects.
5. Add retrieveCorpusContext in server/agent/corpus/retrieve.ts. It should embed a query, search the four Vectorize indexes, resolve vectorize IDs through Postgres, fetch chunk text from R2, rank/dedupe results, and return a structured result. Use mockable interfaces so tests do not require Cloudflare.
6. Convert server/agent/rag.ts to support async corpus retrieval while keeping live Studio script retrieval and docs. Format corpus chunks under [Open-source Roblox corpus examples] with provenance, license, trust_level, quality_score, chunk_type, game, path, reason, and code content.
7. Update server/agent/runtime.ts to await the async RAG builder on iteration 1 before the model call.
8. Add focused Vitest coverage for disabled config, extraction metadata, chunking, formatting budget, retrieval mocks, and RAG integration.
9. Run npm run typecheck and the relevant tests.

Important behavior:

- Authority order must be live project > current session index > official Roblox docs > open-source corpus.
- Corpus examples are reference material only. They must never override live project state.
- Do not tell the model to output Lua code in chat. Stud must continue writing scripts directly into Studio through mcp__roblox_studio__create_instance and mcp__roblox_studio__write_script.
- If Cloudflare/Postgres credentials are absent, return no corpus context and log a concise warning only when corpus is explicitly enabled.
- Avoid adding frontend UI until server-side ingestion and retrieval are working.

Deliverables:

- New server/agent/corpus modules
- schema.sql
- package.json ingestion script
- updated .env.example
- async RAG integration
- tests
- short implementation summary with verification commands and any known gaps
```
