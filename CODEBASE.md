# Stud Codebase Knowledge Base

**Stud** is an AI agent for Roblox Studio — "Cursor AI for Roblox." It connects AI assistants (Claude, OpenAI, OpenRouter) to Roblox Studio via an HTTP bridge, letting the AI read and write scripts, manipulate the instance hierarchy, set properties, and manage DataStores through natural language.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                  Browser (React + Vite)               │
│  src/  — chat UI, settings, stores, AI client layer   │
└────────────────────┬─────────────────────────────────┘
                     │  HTTP (fetch / SSE)
                     ▼
┌──────────────────────────────────────────────────────┐
│               Bridge Server  server/index.js          │
│  Express on :3001 — sessions, relay, OAuth, routes    │
│                                                       │
│  server/agent/  — autonomous agent runtime            │
│    runtime.ts   tools  rag  retrieval  docs  prompt   │
└────────────────────┬─────────────────────────────────┘
                     │  100ms polling  (Roblox Studio can only SEND, not receive)
                     ▼
┌──────────────────────────────────────────────────────┐
│          Roblox Studio Plugin  (Lua)                  │
│  studio-plugin/stud-bridge.server.lua                 │
│  Polls /poll, executes commands, creates undo waypoints│
└──────────────────────────────────────────────────────┘
```

The polling pattern is fundamental: Roblox Studio cannot receive HTTP requests so the plugin polls the bridge; the bridge queues commands sent by the web app.

---

## Directory Map

```
stud/
├── src/                        # React frontend
│   ├── components/             # UI components
│   │   ├── chat/               # Message list, input, tool call display
│   │   ├── settings/           # Settings panel, model picker, auth
│   │   ├── ui/                 # shadcn/ui + prompt-kit primitives
│   │   └── ...                 # ConnectionStatus, SessionCode, QuickActions
│   ├── lib/
│   │   ├── ai/                 # AI providers, server-agent client, types
│   │   ├── bridge/             # Session ID helper, bridge URL config
│   │   ├── roblox/             # Studio HTTP client + AI tool definitions
│   │   ├── auth/               # Codex auth flow
│   │   ├── models/             # Model list fetching + caching
│   │   └── http.ts             # Shared fetch wrapper
│   └── stores/                 # Zustand stores (chat, settings, auth, roblox, plugin, models)
├── server/
│   ├── index.js                # Express entry, routes, session management, relay
│   └── agent/
│       ├── runtime.ts          # AgentRuntime — run lifecycle, tool dispatch, approval flow
│       ├── types.ts            # Shared types for agent, conversations, tools, events
│       ├── tools.ts            # RobloxStudioMcpGateway — MCP tool registry
│       ├── system-prompt.ts    # Prime directive system prompt (no code blocks, only tool calls)
│       ├── rag.ts              # RAG context builder (live scripts + docs)
│       ├── retrieval.ts        # ScriptIndexer — in-memory TF-IDF over live Studio scripts
│       ├── docs.ts             # Hardcoded Roblox API reference chunks (keyword retrieval)
│       ├── context.ts          # @mention resolution from live Studio
│       ├── plan.ts             # Plan mode — structured step proposal + approval
│       ├── policy.ts           # PermissionPolicy — tool risk assessment, scope approval
│       ├── scheduler.ts        # Parallel/sequential batch execution of tool calls
│       ├── conflict.ts         # Concurrent edit conflict detection
│       ├── subagent.ts         # Specialist subagent spawning (debugger, ui, combat, network)
│       ├── drivers.ts          # ModelDriver factory (Anthropic / OpenAI abstraction)
│       ├── gateway-driver.ts   # Driver for Stud's own gateway API
│       ├── ai-config.ts        # AI model config loader
│       ├── store.ts            # ConversationStore (Postgres default, file/memory fallbacks)
│       ├── prisma.ts           # Shared Prisma client / pg adapter
│       ├── playtest.ts         # Playtest session management
│       ├── playtest-tools.ts   # Tools for playtest control
│       ├── toolbox.ts          # Roblox toolbox search / asset insert
│       ├── open-cloud.ts       # Open Cloud API wrappers
│       ├── datastore-tools.ts  # DataStore tools (read/write via Open Cloud)
│       ├── rate-limit.ts       # Per-user rate limiting
│       ├── mcp-server.ts       # MCP server adapter for Studio relay
│       ├── studio-transport.ts # HTTP transport to Studio plugin
│       ├── routes.ts           # Agent HTTP route handlers
│       └── corpus/             # Knowledge base infrastructure (Phase 1–3 complete)
│           ├── config.ts       # Corpus env config (disabled by default)
│           ├── resources.ts    # Cloudflare R2 + Vectorize setup commands
│           ├── schema.sql      # SQL reference (Prisma is authoritative)
│           └── README.md       # Phase docs
├── prisma/
│   └── schema.prisma           # Corpus DB schema (games, chunks, patterns)
├── studio-plugin/
│   └── stud-bridge.server.lua  # Roblox Studio plugin
├── knowledge-base/
│   └── ROBLOX_OPEN_SOURCE_GAME_KNOWLEDGE_BASE_PLAN.md
└── CLAUDE.md                   # Claude Code instructions
```

---

## Frontend (`src/`)

### State Management — Zustand Stores

All global state lives in `src/stores/`. Stores use `zustand` with `immer`-style mutations where needed.

| Store | File | Manages |
|-------|------|---------|
| Chat | `chat.ts` | Message history, run status, streaming state |
| Settings | `settings.ts` | Model selection, provider keys, UI preferences |
| Auth | `auth.ts` | Codex/OAuth session token |
| Roblox | `roblox.ts` | Studio connection status, session pairing |
| Plugin | `plugin.ts` | Plugin health + last poll timestamp |
| Models | `models.ts` | Available model list (fetched + cached) |
| Prerequisites | `prereq.ts` | Onboarding checks (plugin installed, studio connected) |
| Studio Token | `studio-token.ts` | Studio access token for Open Cloud |

### AI Client Layer (`src/lib/ai/`)

- **`server-agent.ts`** — The main client for the server-side agent. Calls `POST /agent/conversations/:id/runs` and streams SSE events back to the chat UI. Maps `text_delta`, `tool_call`, `tool_result`, `run_completed`, `approval_pending`, `interaction_requested` events into Zustand chat state.
- **`providers.ts`** — Direct provider SDK usage (Vercel AI SDK) for client-side calls. Used for simpler/legacy paths; the main path goes through the server agent.
- **`gateway-client.ts`** — Client for Stud's own hosted gateway (proxies model calls with Stud credentials).
- **`profiles.ts`** — AI personality / instruction profiles per provider.
- **`types.ts`** — Shared AI message and tool call types.

### Bridge Client (`src/lib/bridge/`)

- **`session.ts`** — Generates and persists the `sessionId` used to pair the web app with a Studio plugin instance. Stored in localStorage.
- **`config.ts`** — Bridge base URL (defaults to `http://localhost:3001`).

### Roblox Client (`src/lib/roblox/`)

- **`client.ts`** — Low-level HTTP client for `/stud/sessions/:id/request` on the bridge. Sends JSON commands and waits for the plugin to execute and respond.
- **`tools.ts`** — Defines all AI tool schemas (Zod) and their implementations. Each tool builds a command object and calls `studioRequest()`. Tools: `roblox_get_script`, `roblox_set_script`, `roblox_edit_script`, `roblox_get_children`, `roblox_get_properties`, `roblox_set_property`, `roblox_create`, `roblox_delete`, `roblox_clone`, `roblox_move`, `roblox_search`, `roblox_get_selection`, `roblox_run_code`, `roblox_bulk_create`, `roblox_bulk_delete`, `roblox_bulk_set_property`.
- **`toolbox.ts`** — Roblox Creator Marketplace (toolbox) search and asset insertion.

### UI Components (`src/components/`)

Built with shadcn/ui (New York style) + Tailwind CSS 4 + prompt-kit.

Key components:

| Component | Purpose |
|-----------|---------|
| `chat/` | Chat message list, streaming renderer, tool call display |
| `settings/SettingsPanel.tsx` | Full settings overlay |
| `ConnectionStatus.tsx` | Studio connection indicator |
| `SessionCode.tsx` | Session pairing code display |
| `QuickActions.tsx` | Prompt suggestion chips |
| `EmptyState.tsx` | Welcome / no-messages state |
| `ui/` | All shadcn + prompt-kit primitives |

Prompt-kit components used: `PromptInput`, `ChatContainer`, `Message`, `ToolCall`, `Loader`, `Reasoning`, `ResponseStream`, `Markdown`, `CodeBlock`, `PromptSuggestion`, `ScrollButton`.

---

## Bridge Server (`server/index.js`)

Express server on port 3001. Responsibilities:

1. **Session management** — Each web+plugin pair shares a `sessionId`. The bridge keeps a per-session request queue.
2. **Web→Plugin relay** — `POST /stud/sessions/:id/request` enqueues a command. The plugin polls `GET /poll` and picks it up. The plugin posts the result to `POST /respond`. The web app gets the result via long-poll or SSE.
3. **Agent routes** — Delegates to `server/agent/routes.ts` for conversation and run management.
4. **OAuth** — Handles provider OAuth redirect flows.
5. **Codex proxy** — Proxies requests to the Stud gateway when the user uses Stud's own API key.
6. **Open Cloud** — Exposes endpoints that wrap Roblox Open Cloud APIs.

---

## Agent Runtime (`server/agent/`)

The agent runtime is the core of Stud's intelligence. It is an autonomous multi-turn loop that calls an LLM, dispatches tool calls to Studio, handles approvals, and streams events back to the client.

### `runtime.ts` — AgentRuntime

The central class. Key methods:

- **`startRun(conversationId, input)`** — Creates an `AgentRun`, pushes the user message into the conversation, launches `execute()` in a background async loop, returns immediately.
- **`execute(conversationId, runId, input)`** — The main loop (up to `maxIterations = 50`):
  1. **Iteration 1 only:** resolve `@mentions` from live Studio, call `buildRagContext()` for retrieved context (live scripts + docs), inject as `systemContext`.
  2. Call `driver.generate(messages, systemContext, signal, onTextDelta)` → get `{text, toolCalls}`.
  3. Detect "code block without tool call" (model outputted Lua instead of using tools) → inject correction and loop.
  4. If no tool calls → run is complete, emit `run_completed`.
  5. If tool calls → `runToolBatch()` → dispatch through `executeBatches()` → `handleToolCall()`.
- **`handleToolCall()`** — Applies `PermissionPolicy.assess()`. If `deny` → return denied. If `ask` → `requestApproval()` (wait for user). If `allow` → call `tool.execute()`. Audit-logs everything.
- **`requestApproval()`** — Suspends the run, emits `approval_pending` to the client, waits for `answerApproval()` to be called.
- **`requestInteraction()`** — Suspends for a multi-question user interaction (`interaction_requested`).

### `types.ts`

All shared TypeScript types:
- `Conversation` — messages, runs, events, approved scopes, audit log, proposed/approved plan
- `AgentRun` — id, status, mode (execute/plan), tier, iterations
- `AgentTool` — name, description, risk, execute, preview, redactInput
- `AgentToolRegistry` — get/list
- `AgentEvent` / `AgentEventData` — all SSE event payloads
- `ModelDriver` / `ModelDriverFactory` — model abstraction
- `ToolExecutionContext` — passed to every tool execute call

### `tools.ts` — RobloxStudioMcpGateway

Builds the tool registry from MCP (Model Context Protocol) tools exposed by the Studio relay. Wraps each MCP tool as an `AgentTool` with risk classification, input redaction for sensitive params, and preview generation. Also registers DataStore tools, toolbox tools, playtest tools, subagent tools, and the plan-proposal tool.

### `rag.ts` — RAG Context Builder

Called once per run on iteration 1. Builds the `<roblox_retrieved_context>` block:

```
<roblox_retrieved_context>
Authority order: live project > official docs. Prefer project context over examples.

[Live Studio project scripts]
path: game.ServerScriptService.Main
class: Script | run_side: server
symbols: init, handlePurchase
```luau
...source...
```

[Roblox API reference]
topic: Client-server communication via RemoteEvent
...
</roblox_retrieved_context>
```

Sources:
1. **`retrieval.ts`** (`ScriptIndexer`) — in-memory TF-IDF over all scripts indexed from the live Studio session.
2. **`docs.ts`** (`retrieveDocs`) — keyword match over hardcoded Roblox API reference chunks (RemoteEvent, RemoteFunction, Services, task, ModuleScript, Instance, RunService, Players, DataStore, Luau typing, CollectionService, TweenService).

### `retrieval.ts` — ScriptIndexer

Session-scoped in-memory index. The Studio plugin pushes script content to the bridge when scripts change; the bridge indexes them with:
- Path-based scoring (+3 for path match)
- Symbol-based scoring (+2 for function name match)  
- Source-text scoring (+1 for any mention)

Returns top-k chunks ranked by score.

### `docs.ts` — Roblox API Reference

12 hardcoded doc chunks covering the most-needed Roblox APIs. Scored by keyword overlap. Used as fallback when live Studio context doesn't cover a topic.

### `system-prompt.ts` — Prime Directive

The system prompt enforces:
- **Never output code blocks** — all Lua goes into Studio via tools
- **Never write instructions** — execute, don't explain
- Correct tool call sequence: read hierarchy → create instance → write source → set properties → verify
- Path format: `game.Service.Child` (dot-separated, never slashes)
- Script placement rules (server/client/module)
- Recovery rules for tool failures
- Correction loop for code-block violations

### `policy.ts` — PermissionPolicy

Classifies every tool call by risk and decides `allow`, `ask`, or `deny`:
- `read` risk → always `allow`
- `mutation` risk → `ask` unless scope pre-approved
- `external_asset` risk → `ask` with optional "insert without scripts" option
- `elevated` risk → always `ask` regardless of scope
- Plan mode: cross-references proposed/approved plan steps

### `plan.ts` — Plan Mode

When `run.mode === "plan"`, the agent proposes a structured plan (list of steps with risk + scope metadata) before executing. The user approves or rejects the plan. Approved plans unlock pre-authorized scopes for each step.

### `scheduler.ts` — Batch Execution

Groups tool calls into sequential batches where dependencies require ordering. Independent calls in a batch run in parallel via `Promise.all`. Respects `AbortSignal`.

### `context.ts` — @Mention Resolution

Parses `@path` references from user messages (e.g. `@game.ServerScriptService.Main`). Fetches the referenced script source from the live Studio relay and injects it as a context block before the model call.

### `subagent.ts` — Specialist Subagents

Spawns focused sub-runs with restricted tool sets and specialist system prompts:
- `debugger` — reads scripts, identifies bugs, proposes fixes
- `ui_specialist` — GUI layout and ScreenGui work
- `combat_specialist` — combat systems, hitboxes, damage
- `network_specialist` — remote events, security, server authority

Subagents are read-only; their proposals are executed by the parent agent.

### `store.ts` — ConversationStore

Durable persistence for agent conversations, runs, events, approvals, plans, and audit logs.

- **Default:** `PostgresConversationStore` is selected automatically when `DATABASE_URL` exists.
- **Fallbacks:** set `STUD_AGENT_STORE=file` for `.stud/agent-conversations/` JSON snapshot + JSONL event logs, or `STUD_AGENT_STORE=memory` for tests/dev-only memory state.
- **Postgres layout:** `agent_conversations` stores conversation snapshots; `agent_events` stores append-only streamed/runtime events by `conversation_id + sequence`.
- **Crash recovery:** `recoverFromCrash()` cancels stale running runs and clears pending approvals/interactions so reconnecting clients do not see ghost prompts.

### `drivers.ts` — Model Drivers

Abstracts Anthropic and OpenAI APIs behind a common `ModelDriver` interface:
```ts
interface ModelDriver {
  generate(opts: { messages, signal, systemContext?, onTextDelta }): Promise<{ text, toolCalls }>
}
```
Driver selection is by tier (free/pro/ultra) and devModel override.

### `corpus/` — Knowledge Base Infrastructure (Phases 1–3)

Phase 1–3 of the Roblox open-source game knowledge base plan. Currently implemented:

| File | What it does |
|------|-------------|
| `config.ts` | Loads corpus env vars; `ready: false` by default; `nicheIndexPrefix` drives index naming |
| `types.ts` | Shared types: `GameMeta`, `ScriptFile`, `RawChunk`, `CorpusRetrievalResult`, `VectorRecord` |
| `cloudflare.ts` | CF REST API client: `embed`, `upsertVectors`, `queryVectors`, `putR2Object`, `getR2Object`, `createVectorizeIndex` |
| `extract.ts` | Downloads `.lua`/`.luau` files from R2 via manifest; extracts services, remotes, symbols, requires |
| `chunk.ts` | Builds summary + system + script chunks from extracted files |
| `postgres.ts` | Prisma operations: `getPendingGames`, `upsertChunks`, `markGameIngested`, `resolveVectorizeIds` |
| `ingest.ts` | Hourly cron: processes pending games from Postgres → chunks → embeds → Vectorize + R2 upsert |
| `retrieve.ts` | Keyword niche detection → Vectorize query → Postgres resolve → R2 fetch → ranked chunks |
| `resources.ts` | Generates `wrangler` commands to create R2 bucket + niche Vectorize indexes |
| `schema.sql` | SQL reference (non-authoritative; `prisma/schema.prisma` is the source of truth) |

**Vectorize indexes are niche-based** (`roblox-tower-defense`, `roblox-fps`, `roblox-obby`, etc.) created on demand per game. No license checking. Corpus disabled by default.

---

## Prisma Schema (`prisma/schema.prisma`)

Core app persistence:

- **`AgentConversation` / `agent_conversations`** — one row per chat/Studio session conversation: Studio session id, access token hash, messages, runs, approved scopes, audit events, pending approvals/interactions, and plan state.
- **`AgentEventLog` / `agent_events`** — append-only event stream for SSE/runtime events (`text_delta`, `tool_call`, `tool_result`, approvals, run completion, errors).
- **`StudioToken` / `studio_tokens`** — hashed Studio plugin tokens and session ids. Active tokens load from Postgres on server boot; JSON file persistence is only used when `DATABASE_URL` is absent.
- **`AppUser` / `users`** — product user records, including optional email/profile fields and a dev-only anonymous flag.
- **`UserSettings` / `user_settings`** — persisted app/model settings per user.
- **`ProviderCredential` / `provider_credentials`** — encrypted per-user provider credentials metadata/storage scaffold for future user-owned model keys.

### Dev Mode Guard

- Dev mode/model override is disabled unless `STUD_DEV_MODE_ENABLED=true`.
- If `STUD_DEV_MODE_TOKEN` is set, server routes require `X-Stud-Dev-Token` before exposing model lists or accepting `devModel`.
- The header dev-mode toggle is only rendered when `/agent/config` returns `devModeAllowed: true`; turning it off clears the selected dev model and returns to normal tier routing.

Corpus knowledge base:

- **`Game`** — one row per open-source game: slug, name, genre, mechanics[], services[], quality_score, R2 prefix, trust_level, license_status
- **`Chunk`** — one per vector chunk: game_id, chunk_type (summary/system/script/pattern), vectorize_id, r2_path, file_path, roblox_path, script_type, symbols[], services[], quality_score

Corpus retrieval logging:

- Set `CORPUS_LOG_RETRIEVAL=true` to log live corpus retrieval stages: query/niche detection, Workers AI embedding, Vectorize indexes queried, returned matches, Postgres vector id resolution, R2 chunk fetches, selected chunks, and final RAG injection.

Scripts: `db:generate`, `db:migrate`, `db:migrate:deploy`, `db:studio`

---

## Studio Plugin (`studio-plugin/stud-bridge.server.lua`)

Lua plugin that runs inside Roblox Studio. Key behavior:

1. **Polls** `GET /poll?sessionId=X` every 100ms.
2. **Deserializes** the command JSON.
3. **Dispatches** to the appropriate handler (read script, write script, create instance, set property, get children, etc.).
4. **Creates undo waypoints** before mutations so Studio's Ctrl+Z works.
5. **Posts results** to `POST /respond?sessionId=X`.

The plugin is the only thing that can touch Roblox Studio internals; the bridge and web app only communicate via this polling relay.

---

## Data Flow — Full Request Lifecycle

1. User types a message in the React chat UI.
2. `src/lib/ai/server-agent.ts` posts to `POST /agent/conversations/:id/runs`.
3. `AgentRuntime.startRun()` creates a run and launches `execute()` async.
4. Iteration 1: RAG context built (`buildRagContext` → ScriptIndexer + docs). Optional @mentions resolved from Studio.
5. `driver.generate()` calls the LLM (Anthropic/OpenAI) with messages + system context.
6. LLM responds with `text_delta` events (streamed to client via SSE) and `toolCalls`.
7. Tool calls dispatched: `policy.assess()` → `ask` approvals → `tool.execute()`.
8. Tool execution sends command to bridge → bridge queues it → plugin polls and runs it → plugin posts result → bridge resolves the pending tool call.
9. Tool result added to conversation messages. Loop continues until no more tool calls.
10. `run_completed` event emitted. Chat UI marks run as done.

---

## Knowledge Base Plan Progress

The plan lives at `knowledge-base/ROBLOX_OPEN_SOURCE_GAME_KNOWLEDGE_BASE_PLAN.md`. Current status:

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Decisions: v1 = filesystem/Rojo-style `.lua`/`.luau`, local CLI ingestion, license policy | ✅ Done |
| 1 | Corpus config (`server/agent/corpus/config.ts`), `.env.example` vars, disabled by default | ✅ Done |
| 2 | Prisma schema (`prisma/schema.prisma`): games, chunks, patterns tables | ✅ Done |
| 3 | Cloudflare resources setup commands (`resources.ts`), `wrangler` R2 + Vectorize | ✅ Done |
| 4 | Local ingestion CLI: `extract.ts`, `chunk.ts`, `analyze.ts`, `ingest.ts`, `cloudflare.ts`, `postgres.ts` | ❌ Not started |
| 5 | Chunking rules implementation: summary/system/script/pattern chunks | ❌ Not started |
| 6 | `retrieve.ts` — embed query → search Vectorize → resolve via Postgres → fetch R2 → rank | ❌ Not started |
| 7 | Integrate async corpus retrieval into `rag.ts` (add `[Open-source Roblox corpus examples]` block) | ❌ Not started |
| 8 | Update `runtime.ts` to await async RAG on iteration 1 | ❌ Not started |
| 9 | Tests: extract, chunk, format, retrieval mocks, RAG integration | ❌ Not started |
| 10 | System prompt policy language for corpus examples | ❌ Not started |
| 11 | Optional admin UI (corpus status, search preview, game list) | ❌ Not started |
| 12 | Hosted Cloudflare Worker ingestion | ❌ Not started |

**Summary: Phases 0–9 complete. Niche-based Vectorize indexes, cron ingestion, retrieval, async RAG integration, and tests all built and passing. To activate: set `CORPUS_ENABLED=true` + Cloudflare + Postgres creds, upload game files to R2 with `manifest.json`, insert a `Game` row with `ingested=false`, restart server.**

---

## Environment Variables

```bash
# AI Providers
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=

# Stud Gateway (optional — for Stud's own hosted model access)
STUD_GATEWAY_URL=
STUD_GATEWAY_KEY=

# Corpus (all optional — corpus disabled unless CORPUS_ENABLED=true)
CORPUS_ENABLED=false
CORPUS_LOG_RETRIEVAL=false
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
STUD_AGENT_STORE=postgres|file|memory  # optional override; default uses Postgres when DATABASE_URL exists
STUD_DEV_MODE_ENABLED=false            # true only in the developer/private environment
STUD_DEV_MODE_TOKEN=                   # optional server-side secret required for dev mode/model list
VITE_STUD_DEV_MODE_TOKEN=              # optional local-dev convenience; do not set in public builds
```

---

## Build & Dev Commands

```bash
npm run dev                    # Web (5173) + bridge (3001) concurrently
npm run dev:web                # Frontend only
npm run dev:bridge             # Bridge only (bun server/index.js)
npm run build                  # tsc + vite build
npx tsc --noEmit               # Type check frontend
tsc -p tsconfig.server.json    # Type check server
npm test                       # vitest (watch)
npm run test:run               # vitest (single run)

# Corpus / DB
npm run db:generate            # bunx prisma generate

npm run db:migrate             # bunx prisma migrate dev
npm run db:migrate:deploy      # bunx prisma migrate deploy
npm run db:studio              # Prisma Studio UI
npm run corpus:cloudflare:setup          # Preview wrangler commands
npm run corpus:cloudflare:setup:execute  # Run wrangler commands
```

---

## Corpus Scripts (`scripts/`)

All scripts read `.env` for credentials. Run from the repo root.

### Full pipeline order

```bash
# 1. Convert all .rbxl files in ~/stud/games/ → ~/stud/games/converted/
bun run scripts/batch-convert.ts

# 2. Sync local converted games to R2 + register in Postgres
#    Skips games already in both. ACID: rolls back R2 on Postgres failure.
bun run scripts/sync-corpus.ts --dry-run   # preview
bun run scripts/sync-corpus.ts             # apply (concurrency=5 default)
bun run scripts/sync-corpus.ts --concurrency=10

# 3. If R2 already has files but Postgres is empty — register only
bun run scripts/register-games.ts

# 4. Migrate raw game name slugs to URL-safe slugs (r2Prefix untouched)
bun run scripts/migrate-slugs.ts --dry-run  # preview old→new mappings
bun run scripts/migrate-slugs.ts --apply    # run inside a transaction

# 5. Create embeddings + push to Vectorize
bun run scripts/embed-games.ts --games=10         # next 10 un-ingested
bun run scripts/embed-games.ts --games=all        # everything
bun run scripts/embed-games.ts --slug=flood-escape # one specific game
bun run scripts/embed-games.ts --games=20 --dry-run
bun run scripts/embed-games.ts --slug=flood-escape --cleanup # delete generated chunks/vectors and mark un-ingested

# 6. Trigger ingestion via server (server must be running)
curl -X POST http://localhost:3001/corpus/ingest
curl http://localhost:3001/corpus/status
```

### Script reference

| Script | Purpose |
|--------|---------|
| `batch-convert.ts` | Parses `.rbxl` binary → extracts `.lua` files + `manifest.json` per game. Pure Bun, no external tools. |
| `sync-corpus.ts` | Source of truth sync: checks R2 + Postgres state per game, uploads missing files, inserts missing rows. ACID rollback on failure. |
| `register-games.ts` | Registers games already on R2 into Postgres (R2 verification required before insert). |
| `upload-all.ts` | Bulk R2 upload with concurrency + retry. Use `sync-corpus.ts` instead for new work. |
| `upload-game.ts` | Single-game R2 upload + Postgres register. |
| `embed-games.ts` | Reads R2 → builds chunks → embeds via Workers AI → upserts Vectorize → writes Postgres. Deterministic IDs, duplicate-safe. |
| `test-vectorize.ts` | Diagnostic for Workers AI + Vectorize auth/index/upsert/query/delete using Vectorize V2 endpoints. Cleans diagnostic vectors after the run. |
| `migrate-slugs.ts` | Converts raw game names to URL-safe slugs in Postgres. Never touches R2. Dry-run + transaction. |
| `generate-manifests.ts` | Generates `manifest.json` for already-converted game folders + prints SQL inserts. |

### Game states

```
Not converted        → run batch-convert.ts
Converted locally    → run sync-corpus.ts
In R2, not Postgres  → run register-games.ts
In Postgres, not R2  → sync-corpus.ts re-uploads
Both, not embedded   → run embed-games.ts
Embedded, bad run    → run embed-games.ts --slug=<slug> --cleanup
Slugs not URL-safe   → run migrate-slugs.ts --apply
```

### Corpus storage model

- Raw game scripts live in R2 under each game's `r2Prefix` plus `manifest.json`.
- Generated retrieval chunk text lives in R2 under `{slug}/chunks/...`.
- Vectorize stores only embeddings plus small metadata (`r2Path`, game slug/name, niche, chunk type, Roblox path).
- Postgres `chunks` rows store the lookup catalog: `vectorizeId`, `vectorizeIndex`, `r2Path`, metadata, tags, symbols, remotes, and services.
- Retrieval flow: embed query → Vectorize nearest-neighbor search → use returned ids/metadata to find Postgres chunk rows → fetch full chunk text from R2.

---

## StudLandingPage (`StudLandingPage/`)

Next.js 16.2.6 (App Router) marketing landing page for Stud. Deployed to Cloudflare Pages as a fully static export.

- **`next.config.ts`** — Turbopack enabled; no `output` override (standalone-compatible for `@opennextjs/cloudflare`).
- **`open-next.config.ts`** — Full Cloudflare adapter config: `wrapper: "cloudflare-node"`, `converter: "edge"`, all caches set to `"dummy"`, `edgeExternals: ["node:crypto"]`. Using dummy caches means no `WORKER_SELF_REFERENCE` or R2 bindings needed. Excluded from `tsconfig.json` (package installed locally as devDep, types available, but file lives outside Next.js compilation scope).
- **`wrangler.jsonc`** — Minimal Cloudflare Workers config: name `stud-landing-page`, points `main` at `.open-next/worker.js`, `assets.directory` at `.open-next/assets`. No `WORKER_SELF_REFERENCE` binding (dummy caches don't need it). No `r2_buckets` (no ISR).
- **`package.json`** — `@opennextjs/cloudflare: "latest"` in devDependencies so `bunx opennextjs-cloudflare build` resolves the binary from `node_modules/.bin/`.
- Build command: `bunx opennextjs-cloudflare build` → full pipeline runs locally and on Cloudflare Pages.
- **`src/app/page.tsx`** — Single `"use client"` page with all landing page sections (hero, features, tools, permissions, CTA, footer, waitlist modal).
- **`src/app/layout.tsx`** — Minimal App Router layout with metadata (title, icons).
- **`public/stud/assets/`** — Images, video clips, fonts served at `/stud/assets/...` paths.
- No server-side code, no API routes, no ISR — purely client-rendered.

---

## Product Planning Docs

- **`MVP_NEXT_STEPS.md`** — Product-ready MVP checklist for Stud, including architecture decision, must-have build phases, database/storage notes, smoke tests, deferred features, and copy-paste prompts for future implementation runs.

---

## Key Conventions

- `const` over `let`; ternaries over if/else assignment
- Early returns, not else chains
- No `try/catch` unless at a true system boundary
- No `any` type; rely on inference
- Single-word variable names where context is clear (`obj.a` not `const { a } = obj`)
- No co-author lines in git commits
- Parallel tool calls whenever possible in agent/scheduler code
- No comments unless the WHY is non-obvious
