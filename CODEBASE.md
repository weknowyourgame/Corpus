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
│       ├── app-config.ts       # DB-backed runtime app/dev config
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
| Settings | `settings.ts` | Tier/dev-model/UI preferences; localStorage cache + Postgres sync for logged-in users; no provider API keys |
| Auth | `auth.ts` | Cookie-backed Stud auth session, login/logout state, Google OAuth redirect completion |
| Roblox | `roblox.ts` | Studio connection status, session pairing |
| Plugin | `plugin.ts` | Plugin health + last poll timestamp |
| Models | `models.ts` | Available model list (fetched + cached) |
| Prerequisites | `prereq.ts` | End-user onboarding checks only: Roblox Studio, Stud plugin, bridge server, and Studio connection. Server-side model access is not shown as a prerequisite. |
| Studio Token | `studio-token.ts` | Studio access token for Open Cloud |

Connection screen:

- `Home.tsx` shows `StudioToken` on the Roblox Studio connection screen because users need that token/QR to pair the Studio plugin. The screen intentionally avoids the extra bridge/MCP route badges and noisy plugin-status badge in this onboarding view.

### AI Client Layer (`src/lib/ai/`)

- **`server-agent.ts`** — The main client for the server-side agent. Calls `POST /agent/conversations/:id/runs` and streams SSE events back to the chat UI. Maps `text_delta`, `tool_call`, `tool_result`, `run_completed`, `approval_pending`, `interaction_requested` events into Zustand chat state.
- **`providers.ts`** — Browser-safe compatibility shim only; frontend AI calls route through the server agent and never receive provider keys.
- **`gateway-client.ts`** — Server-side gateway helper for Stud-owned model credentials and hosted/Cloudflare gateway paths.
- **`profiles.ts`** — AI personality / instruction profiles per provider.
- **`types.ts`** — Shared AI message and tool call types.
- **Dev model config UI** — `components/settings/DevModelConfigDialog.tsx` is shown only when `/agent/config` reports `devModeAllowed: true`. It edits model overrides through `GET/PATCH /agent/dev/model-config` for every server profile (`planner-*`, `coder-*`, `classifier`, `summarizer`, `title-generator`, `embeddings`). Overrides are saved in `app_config` under `dev.modelOverrides`, hydrated into bridge memory, and survive restarts. If `STUD_DEV_MODE_TOKEN` is required and missing, the dialog shows an unlock input that stores trimmed `localStorage.stud_dev_mode_token` and surfaces exact 401/403 server errors.
- **Dev rate-limit UI** — `components/settings/DevRateLimitsDialog.tsx` is shown beside the dev model config button when dev mode is allowed. It edits runtime max-concurrent-run and per-tier RPM limits through `GET/PATCH/POST /agent/dev/rate-limits`; values are saved in `app_config` under `dev.rateLimits`, hydrated into bridge memory, and survive restarts. Token locking uses the same `localStorage.stud_dev_mode_token` unlock flow and exact error reporting.

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

**Connection model** — one active path: browser → bridge → Stud Studio plugin (polls bridge) → Roblox Studio. No "official MCP" or "plugin fallback" concepts in the UI.

**Transport strings** — `effectiveTransport` / `preferredTransport` / `lastUsedTransport` are `"studio_plugin" | "unknown"`. `"official_mcp"` and `"plugin_fallback"` no longer appear anywhere in user-facing code. Internal `mcp__roblox_studio__*` tool-name prefixes and `mcp-server.ts` (JSON-RPC adapter) keep their names as implementation details.

### Tool Result UX

- Tool input/output JSON is debug-only and lives under a collapsed **Raw details** disclosure.
- Script write/edit mutation results render Claude Code-style structured diffs with file headers, hunks, line numbers, +/− stats, red/green changed lines, word-level highlights, copy-after-source, and full-diff expansion.
- Script creation is inferred when `create_instance` is followed by `write_script` for the same new script path; the write result renders as a green full-file `Created Script` diff.
- Read-only Studio tools render summaries instead of diffs: script reads show path/revision/line count plus a collapsed source preview; children/search/selection/properties render compact lists or tables.
- Non-script mutation tools render human-readable change cards such as created instance, deleted path, changed property, moved/cloned path, or bulk counts with expandable item previews.

---

## Bridge Server (`server/index.js`)

Express server on port 3001. Responsibilities:

1. **Session management** — Each web+plugin pair shares a `sessionId`. The bridge keeps a per-session request queue.
2. **Web→Plugin relay** — `POST /stud/sessions/:id/request` enqueues a command. The plugin polls `GET /poll` and picks it up. The plugin posts the result to `POST /respond`. The web app gets the result via long-poll or SSE.
3. **Auth routes** — Cookie session auth, login-token auth, Google OAuth, logout, and `/auth/me`.
4. **Agent routes** — Delegates to `server/agent/routes.ts` for user-owned conversation, run management, and user settings (`GET /agent/user/settings`, `PATCH /agent/user/settings`).
5. **OAuth** — Handles Google OAuth redirect flows.
5. **Codex proxy** — Proxies requests to Stud-owned hosted model infrastructure when enabled server-side.
6. **Open Cloud** — Exposes endpoints that wrap Roblox Open Cloud APIs.

**Process keep-alive (Bun):** `app.listen()` is captured into `server`; an explicit `setInterval(() => {}, 1<<30)` keeps the event loop alive because under Bun the node:http server handle does not reliably hold the loop open — without it the bridge exits cleanly (code 0) right after binding once startup async work settles (consistently when launched via `concurrently`/`npm run dev`). `server.on("error")` surfaces bind failures (e.g. `EADDRINUSE`) and exits 1 instead of silently mis-binding.

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
- `low_mutation` / `destructive` risk → `ask` unless pre-approved (see scope matching below)
- `external_asset` risk → `ask` with optional "insert without scripts" option
- `elevated`, `runtime_code`, `secret` → always `ask` even in full-access mode
- Plan mode: cross-references proposed/approved plan steps

**Scope matching** — four strategies so "Approve this scope" is reusable:
- `exact` — future tool calls with the same exact scope auto-approved (write_script, edit_script, clone_instance)
- `path_prefix` — any property on the same instance path (set_property: scope=`path.property` → canonical=`path`)
- `parent_class` — any instance of the same class under the same parent (create_instance: scope=`parent/*:class`)
- `tool_family` — bulk operations covering the same parent/class patterns or instance paths (bulk_create, bulk_set_property)

When user clicks "Approve this scope", `deriveScopeInfo(toolName, scope)` computes the canonical scope and strategy stored in `approvedScopes`. The `scopeApprovalDescription` helper generates human-readable copy shown in the approval UI ("Will remember: Any property on game.Workspace.Part").

**Audit trail** — every policy decision includes a `matchReason` field: `exact_scope | path_prefix | parent_class | tool_family | full_access | plan`.

**Full access mode** — opt-in for local/dev:
- Server env: `STUD_FULL_ACCESS_ENABLED=true` (default false). Optional `STUD_FULL_ACCESS_TOKEN` requires matching `X-Stud-Full-Access-Token` header.
- `/agent/config` returns `fullAccessAllowed: true/false` — client only shows toggle when allowed.
- Client passes `fullAccess: true` in run request body. Server validates against env before accepting.
- When `run.fullAccess === true`, policy allows `low_mutation` and `destructive` without prompting. `runtime_code`, `external_asset`, `secret`, and `elevated` still require approval.
- Disabling full access returns to normal approval flow immediately.
- UI: `FullAccessToggle` (⚡ icon) only visible when server reports `fullAccessAllowed`. Active state shown in amber. `fullAccess` preference stored localStorage-only — not synced to server.

**Studio error surfacing** — `surfaceStudioError()` in `tools.ts` normalizes all Studio plugin error responses to `{ success: false, error: "...", hint?: "..." }`. Prevents the agent from silently ignoring failed tool calls. Type-mismatch errors (Vector3/Color3/etc.) get a hint string guiding the agent to correct value format.

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

### Cancellation Model

When the user presses Stop, `POST /agent/conversations/:id/runs/:runId/cancel` is called. The flow:

1. **`AgentRuntime.cancelRun`** — adds `runId` to `cancelledRuns` (synchronous gate) **before** calling `abort()`. This means:
   - The gate is visible to all concurrent coroutines as soon as `cancelRun` starts executing.
   - Any `emit()` call for that `runId` (except `run_cancelled` itself) is dropped and logged.
   - The `runToolBatch` outcomes loop checks `cancelledRuns` after each `await` so no tool results are saved after cancellation.

2. **Bridge-level cleanup** — `cancelRunStudioRequestsFn(sessionId, runId)` is called immediately after `abort()`. It scans `session.pending` for entries whose `operationId` starts with `${runId}:`, rejects them (`"Run cancelled"`), and removes them so the plugin never picks them up. The count is logged.

3. **In-flight Studio requests** — if the plugin already picked up a request (it was dequeued from `session.pending` but no response yet), the abort listener in `relayStudioRequest` removes it when the signal fires. When the plugin eventually responds via `POST /studio/respond`, the pending entry is gone; the response is silently dropped and logged (`[studio] ignored late Studio response for cancelled run`).

4. **Idempotency** — `cancelRun` checks `cancelledRuns.has(runId)` twice (before and after the store `await`) and returns `false` immediately if the run is already being cancelled. Repeated calls to the HTTP cancel endpoint are safe.

5. **SSE client** — `run_cancelled` is a terminal event. The `server-agent.ts` SSE loop calls `callbacks.onFinish()` and exits when it sees `run_cancelled`, matching `run_completed` behaviour.

6. **Other agents unaffected** — `cancelledRuns` is keyed by `runId` (UUID). `cancelRunRequests` filters by `operationId.startsWith(runId + ":")`. Neither touches other conversations or other runs.

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
| `config.ts` | Loads corpus env vars; `ready: false` by default; `nicheIndexPrefix` drives index naming; `minScore` (default 0.70) score gate |
| `types.ts` | Shared types: `GameMeta`, `ScriptFile`, `RawChunk`, `CorpusRetrievalResult`, `VectorRecord` |
| `cloudflare.ts` | CF REST API client: `embed`, `upsertVectors`, `queryVectors`, `putR2Object`, `getR2Object`, `createVectorizeIndex` |
| `extract.ts` | Downloads `.lua`/`.luau` files from R2 via manifest; extracts services, remotes, symbols, requires |
| `chunk.ts` | Builds summary + system + script chunks from extracted files |
| `postgres.ts` | Prisma operations: `getPendingGames`, `upsertChunks`, `markGameIngested`, `resolveVectorizeIds` |
| `ingest.ts` | Hourly cron: processes pending games from Postgres → chunks → embeds → Vectorize + R2 upsert |
| `retrieve.ts` | Demand-driven retrieval: `shouldUseCorpus()` intent gate → niche detection → Vectorize query → score threshold → Postgres resolve → R2 fetch → ranked chunks |
| `resources.ts` | Generates `wrangler` commands to create R2 bucket + niche Vectorize indexes |
| `schema.sql` | SQL reference (non-authoritative; `prisma/schema.prisma` is the source of truth) |

**Vectorize indexes are niche-based** (`roblox-tower-defense`, `roblox-fps`, `roblox-obby`, etc.) created on demand per game. No license checking. Corpus disabled by default.

**Demand-driven corpus retrieval** — `shouldUseCorpus(query)` in `retrieve.ts` gates all corpus calls:
- Skips corpus for greetings, casual chat, and meta/model questions ("what can you do", "hi", "thanks", "are you Claude", etc.)
- `GAME_TERMS_RE` covers full Roblox/game-dev vocabulary: services, scripting concepts (cframe, tween, raycast, debounce), game mechanics (health, damage, coins, shop, stamina), world/UI (frame, hud, billboard, terrain), player systems (leaderboard, xp, badge, vip), and all original service names
- When niche confidence ≥ 2, searches only the specific niche index (topK=12). When confidence < 2, searches ALL niche indexes in parallel (topK=4 each) — no longer searches a non-existent `${prefix}-general` index
- After Vectorize returns matches, a second gate skips injection if the best score is below `CORPUS_MIN_SCORE` (default now **0.50**, previously 0.70)
- Score-gate log line includes top-3 filtered scores for threshold calibration
- Logs skip reason at each gate when `CORPUS_LOG_RETRIEVAL=true`; selected chunks are only logged when actually injected

---

## Prisma Schema (`prisma/schema.prisma`)

Core app persistence:

- **`AgentConversation` / `agent_conversations`** — one row per chat/Studio session conversation: Studio session id, access token hash, messages, runs, approved scopes, audit events, pending approvals/interactions, and plan state.
- **`AuthSession` / `auth_sessions`** — hashed cookie session tokens, expiry, and revocation state for logged-in web users.
- **`LoginToken` / `login_tokens`** — hashed one-time email login tokens and Google OAuth state tokens with expiry/consumption tracking.
- **`AgentEventLog` / `agent_events`** — append-only event stream for SSE/runtime events (`text_delta`, `tool_call`, `tool_result`, approvals, run completion, errors).
- **`StudioToken` / `studio_tokens`** — hashed Studio plugin tokens tied to a `user_id` (nullable for anonymous dev tokens). Active tokens load from Postgres on server boot; JSON file persistence fallback when `DATABASE_URL` is absent. See **Studio Token Ownership** below.
- **`AppUser` / `users`** — product user records, including optional email/profile fields and a dev-only anonymous flag.
- **`UserSettings` / `user_settings`** — persisted app/model settings per user.
- **`ProviderCredential` / `provider_credentials`** — inactive scaffold only for MVP; no routes or UI use it, and users do not enter provider API keys.
- **`AppConfig` / `app_config`** — generic DB-backed app configuration table (`key`, `value` JSON). Used by internal dev controls for model overrides (`dev.modelOverrides`) and rate limits (`dev.rateLimits`).

### Studio Token Ownership

Studio tokens (`studio_tokens` table) carry a `user_id` that ties each token to the user who generated it.

- **Generation** (`POST /auth/studio-token/generate`): when `STUD_ALLOW_ANONYMOUS=true` (local dev), tokens may be created without a logged-in user (`user_id = null`). Otherwise a valid auth session is required and `user_id` is set from the session. Old-token revocation during re-generation is scoped to the current user — a user's `oldToken` can never revoke another user's token.
- **Revocation** (`POST /auth/studio-token/revoke`): requires auth cookie (`credentials: include` on the client). If the token has a `user_id`, the request must be from that same user; mismatched ownership returns 403.
- **Token resolution** (`requireToken`): every plugin request (poll, respond, MCP, direct relay) resolves `{ token, hash, entry }` where `entry` carries `{ sessionId, userId, createdAt }`. The `userId` is available to all downstream handlers.
- **Isolation**: User A cannot revoke, regenerate, or use User B's token. The raw token value is stored only in the generating user's browser localStorage and is never returned after the initial generate response.

### User Settings Sync

Settings are persisted in `user_settings` (Postgres) for session-authenticated non-anonymous users and fall back to localStorage for anonymous/local-dev sessions.

- `GET /agent/user/settings` — returns `{ selectedTier, devMode, devModel, appSettings }` for the current user; 401 if not authenticated; `{ settings: null }` if no row exists yet.
- `PATCH /agent/user/settings` — partial update; `appSettings` is **merged** (not replaced) into the existing JSON column. Returns the full updated settings object.
- **Frontend** (`src/stores/settings.ts`): every setter (`setTier`, `setDevMode`, `setDevModel`, `updateAppSettings`, `resetAppSettings`) fires a fire-and-forget `PATCH /agent/user/settings` with `credentials: include`. Server 401s are silently ignored so the store works identically when offline or unauthenticated.
- **Boot sequence** (`Home.tsx`): when `user.id` is set and `!user.anonymous`, `loadFromServer()` is called. It fetches the server row and merges it over the current localStorage state (server wins). The merged state is then persisted back to localStorage by the zustand `persist` middleware.
- Anonymous local dev (`STUD_ALLOW_ANONYMOUS=true`) skips `loadFromServer` — localStorage is the only store.

### Conversation Ownership Model

Every `agent_conversations` row carries a `user_id` (FK → `users.id`). Ownership is enforced at the route layer via `authorize()` in `server/agent/routes.ts`:

1. `ownsConversation` — checks `conversation.userId === currentUser.id` for session-authenticated users; for anonymous sessions checks `!conversation.userId`.
2. **Session-authenticated users** (non-anonymous, `user.id` set): `userId` match from `ownsConversation` is sufficient. The per-conversation bearer access token is secondary — it is not required when the session cookie proves identity. This allows multi-device access for logged-in users.
3. **Anonymous sessions** (only on localhost when `STUD_ALLOW_ANONYMOUS=true`): no persistent `userId`, so the bearer access token stored in localStorage is the only per-conversation identity guard and is strictly required.
4. User A can never fetch, run, stream, approve, or mutate User B's conversation — all routes call `authorize()` before any runtime call.
5. `GET /agent/conversations` lists by `userId`; anonymous list by `userId: null`.
6. `POST /agent/conversations` sets `userId` from `currentUser.id` at creation time.

### Dev Mode Guard

- `/agent/*` requires a resolved current user by default; unauthenticated requests return 401 unless `STUD_ALLOW_ANONYMOUS=true` on local/dev hosts.
- Studio tokens generated from the web app are stored hashed and now persist `user_id` when a logged-in user creates them.
- Dev mode/model override is disabled unless `STUD_DEV_MODE_ENABLED=true` (server-side only; never set in public deployments).
- If `STUD_DEV_MODE_TOKEN` is set on the server, dev routes require the matching `X-Stud-Dev-Token` header before exposing the model list or accepting `devModel`. Token comparison trims browser and server values. The token is sent from the browser via `localStorage.getItem("stud_dev_mode_token")` only — it is never baked into the JS bundle (`VITE_STUD_DEV_MODE_TOKEN` is intentionally removed).
- Dev-token-unlocked `/agent/config`, `/agent/models`, and `/agent/dev/*` can be reached without a normal auth cookie so local internal controls still work when auth is being debugged.
- The header dev-mode toggle is only rendered when `/agent/config` returns `devModeAllowed: true`; turning it off clears the selected dev model and returns to normal tier routing.
- Dev model config: `GET/PATCH /agent/dev/model-config` uses the same dev-mode gate and lets the running bridge override all model profiles, including memory/suggestions/compaction (`summarizer`) and title generation. Server model resolution goes through `resolveProfileConfig()` so utility LLMs and gateway driver calls honor overrides. Overrides are persisted by `server/agent/app-config.ts` in `app_config.dev.modelOverrides` and hydrated into memory on bridge startup / dev-config reads. The dialog includes an unlock field for `STUD_DEV_MODE_TOKEN`.
- Dev rate limits: `GET/PATCH /agent/dev/rate-limits` and `POST /agent/dev/rate-limits/reset` use the same dev-mode gate. `server/agent/rate-limit.ts` keeps runtime config for `maxConcurrentRuns` plus `free/pro/hyper/super` RPM values; defaults are 2 concurrent runs and 5/20/10/10 runs per minute. Values are persisted by `server/agent/app-config.ts` in `app_config.dev.rateLimits` and hydrated into memory on bridge startup / dev-config reads.
- Production default: `STUD_DEV_MODE_ENABLED` unset or `false` → `/agent/config` returns `devModeAllowed: false` → toggle hidden, dev model list returns `[]`, any `devModel` field in a run request is rejected 403.

Auth routes and env:

- `POST /auth/login/start` — starts email token login or Google OAuth (`provider: "email" | "google"`); stores only hashed login/state tokens. Email-token login requires either local/dev echo (`STUD_LOGIN_TOKEN_ECHO=true` or anonymous local dev) or real Resend delivery via `RESEND_API_KEY` + `STUD_AUTH_EMAIL_FROM`; otherwise it returns 503 instead of pretending an email was sent.
- `POST /auth/login/verify` — verifies email token, Google OAuth code, or Google ID credential; creates an HTTP-only `stud_session` cookie backed by `auth_sessions`.
- `POST /auth/logout` — revokes the current session hash and clears the cookie. Setting `user: null` in auth store causes `Home.tsx` to render `LoginScreen` immediately.
- `GET /auth/me` — returns current user, 401 when logged out and anonymous dev bypass is not enabled.
- **Login UX** — `LoginScreen` in `Home.tsx`: email field is disabled only after email-token start succeeds; when start/verify fails the error is shown and the user stays on the correct step. The main product UI requires a real non-anonymous user; anonymous local-dev auth does not bypass the visible login screen.
- **Google OAuth** — `/auth/login/start` prefers server-side `GOOGLE_REDIRECT_URI` and returns that URI to the browser so login verification uses the same exact callback. `GOOGLE_REDIRECT_URI` must exactly match an Authorized redirect URI in Google Cloud Console.
- **User creation** — login normalizes email to lowercase and uses find/create with `P2002` recovery instead of Prisma `upsert`, avoiding crashes when the unique `users.email` index is hit during repeated or racing login attempts.
- **User badge** — `UserBadge` in `StudAppHeader.tsx` shows avatar (or initial) + truncated display name / email for non-anonymous users. Clicking signs out via `useAuthStore().logout()`.
- Env: `DATABASE_URL`, `STUD_ALLOW_ANONYMOUS`, `STUD_LOGIN_TOKEN_ECHO`, `RESEND_API_KEY`, `STUD_AUTH_EMAIL_FROM`, `STUD_COOKIE_SECURE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

Corpus knowledge base:

- **`Game`** — one row per open-source game: slug, name, genre, mechanics[], services[], quality_score, R2 prefix, trust_level, license_status
- **`Chunk`** — one per vector chunk: game_id, chunk_type (summary/system/script/pattern), vectorize_id, r2_path, file_path, roblox_path, script_type, symbols[], services[], quality_score

Corpus retrieval logging:

- Set `CORPUS_LOG_RETRIEVAL=true` to log live corpus retrieval stages: intent gate decisions (skipped/allowed), query/niche detection, Workers AI embedding, Vectorize indexes queried, returned matches, score threshold gate (skipped by low score), Postgres vector id resolution, R2 chunk fetches, and selected chunks (only logged when actually injected).

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
# Stud-owned model credentials (server/private config only)
AI_GATEWAY_URL=
CLOUDFLARE_API_TOKEN=
OPENROUTER_API_KEY=

# Stud Gateway (optional — for Stud's own hosted model access)
STUD_GATEWAY_URL=
STUD_GATEWAY_KEY=

# Corpus (all optional — corpus disabled unless CORPUS_ENABLED=true)
CORPUS_ENABLED=false
CORPUS_LOG_RETRIEVAL=false
CORPUS_ALLOW_UNKNOWN_LICENSE=false
CORPUS_MIN_SCORE=0.70            # skip injection if best Vectorize score is below this
CORPUS_MAX_CHUNKS=4              # max chunks to inject per run
CORPUS_CONTEXT_MAX_CHARS=6000    # max total chars of corpus context to inject

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
STUD_DEV_MODE_ENABLED=false            # default; set true only in local/private environments — never in public deployments
STUD_DEV_MODE_TOKEN=                   # optional server-side secret; if set, client must send X-Stud-Dev-Token header to unlock dev mode
                                       # set the matching value in browser devtools: localStorage.setItem("stud_dev_mode_token","<token>")
STUD_FULL_ACCESS_ENABLED=false         # default; allow client to enable full-access mode (bypasses mutation approvals)
STUD_FULL_ACCESS_TOKEN=                # optional; if set, client must send X-Stud-Full-Access-Token header
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
bun run scripts/embed-pending-batches.ts --limit=25  # resume helper: one game at a time, continues past failures
bun run scripts/embed-games.ts --games=10         # next 10 un-ingested
bun run scripts/embed-games.ts --games=all        # everything
bun run scripts/embed-games.ts --slug=flood-escape # one specific game
bun run scripts/embed-games.ts --games=20 --dry-run
bun run scripts/embed-games.ts --games=all --backfill-metadata --dry-run
bun run scripts/embed-games.ts --slug=flood-escape --backfill-metadata
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
| `embed-games.ts` | Reads R2 → builds chunks → embeds via Workers AI → upserts Vectorize → writes Postgres. Deterministic IDs, duplicate-safe; `--backfill-metadata` updates existing Postgres metadata without re-embedding or deleting Vectorize vectors. |
| `embed-pending-batches.ts` | Resume helper: queries Postgres for `ingested=false` games, runs `embed-games.ts --slug=<slug>` one at a time. Flags: `--limit=N` (default 25), `--start-after=<slug>`, `--dry-run`. Prints per-game duration, continues past failures, prints failed-slug retry commands at the end. |
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
- Claude Code reference review: `claude-code/` favors demand-driven context/tool loading instead of always-on vector retrieval; Stud corpus should gate retrieval by user intent and relevance score before injecting chunks.
- Corpus metadata note: `scripts/embed-games.ts` reuses the richer shared script parser from `server/agent/corpus/extract.ts`; script chunks should have file path, Roblox path, line range, source hash, symbols, required modules, remotes, services, tags, and quality score populated when source is available.
- Summary and system chunks may legitimately have null `file_path`, `roblox_path`, `line_start`, `line_end`, and `source_hash` when they summarize many files rather than one clear source file.
- Metadata backfill: `bun run scripts/embed-games.ts --slug=<slug> --backfill-metadata`, `--games=all --backfill-metadata`, or `--games=10 --backfill-metadata` rebuilds descriptors from R2/local meta and updates existing Postgres rows by deterministic `vectorizeId` without calling Workers AI, upserting/deleting Vectorize data, or creating duplicate chunk rows.
- Vectorize cleanup guidance: incomplete Postgres metadata does not require deleting vectors; prefer metadata backfill keyed by deterministic `vectorizeId` unless chunk text/IDs/index assignment are wrong.

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
- Auth/dev-mode/provider-key follow-up prompts were drafted in chat; provider credentials MVP direction is Stud-owned server credentials only, with user-facing provider key entry removed/hidden.
- Prompt status audit: corpus gating, auth sessions/login routes, user-owned conversations, settings persistence, provider-key UI removal, and metadata backfill are present; MCP transport wording still has legacy `plugin_fallback`/`official_mcp` labels in UI/status code.
- Local anonymous auth debug: `/auth/me` can still return anonymous local-dev sessions when `STUD_ALLOW_ANONYMOUS=true`, but `Home.tsx` keeps showing `LoginScreen` until a non-anonymous user session exists.
- Dev mode debug: when `STUD_DEV_MODE_TOKEN` is set, browser must set `localStorage.stud_dev_mode_token` to the same value; `/agent/config` returns `devModeAllowed=false` without the `X-Stud-Dev-Token` header.
- Bug prompt audit: cancellation currently aborts the agent run but should also cancel queued/in-flight Studio relay work; approve-scope is exact tool+scope matching and needs broader/persistent scope matching plus an explicit full-access mode.
- Diff prompt audit: Claude Code reference has structured/color diff code under `claude-code/native-ts/color-diff/`; Stud should render script mutations as first-class before/after hunks with line numbers and word highlights, not raw tool JSON.
- Claude Code Part 3 integration: added run-scoped task tools/events (`stud_task_create`, `stud_task_update`, `stud_task_list`) plus `TaskProgress` UI during streaming.
- Claude Code Part 3 integration: plan steps now accept richer structured fields (`index`, `title`, `description`, `toolNames`, `risk`, `scope`, `estimatedChanges`) with `PlanStepList` approval UI.
- Claude Code Part 3 integration: session memory now extracts/stores recent project/preference/pattern facts in `agent_memories` and injects them into future run context.
- Claude Code Part 3 integration: runtime auto-compacts long conversations, emits `context_compacted`, and shows a subtle chat notice.
- Claude Code Part 3 integration: post-run prompt suggestions are generated via `/agent/conversations/:id/suggestions` and shown under the composer.
- Claude Code Part 3 integration: each run creates a Studio ChangeHistoryService waypoint and exposes `/agent/conversations/:id/runs/:runId/restore` for UI "Undo run".
- Claude Code Part 3 integration: external MCP servers from `STUD_MCP_SERVERS=name:url` load as first-class agent tools and `/agent/mcp/status` powers the MCP connection badge.
- Claude Code Part 3 integration: `roblox_spawn_subagent` now supports explore, plan, debugger, ui_specialist, and network_specialist specialists with scoped tools/progress events.
- Auth polish: header shows signed-in user/avatar with sign-out; logout now clears the client session back to the login screen, and email-token login has retry/reset recovery.
- Production hardening: bridge startup rejects unsafe production config (`STUD_ALLOW_ANONYMOUS=true`, dev mode enabled, insecure cookies, or missing database); `.env.example` documents production-safe flags and MCP server config.
- Corpus debug: `GET /corpus/debug` runs a fixed "tycoon dropper income system" retrieval and returns corpus readiness/config plus the retrieval result.
- Corpus ops run: `sync-corpus.ts` synced 439 R2-only games into Postgres with 18 already done; `embed-games.ts --games=all` was started and stopped after slow progress, leaving Postgres at 896 games / 76 ingested / 820 pending / 1,756 chunks.
- MCP management UI: `ConnectionBadges` hides MCP entirely when no external MCP servers are configured. When MCP servers exist or error, the MCP pill opens a dialog with summary counts (configured/connected/tools + last-loaded time), tool search/filter input, per-server connection state + full tool chip list, copyable `STUD_MCP_SERVERS=…` env snippet, and a refresh button that re-fetches `GET /agent/mcp/status` without restarting.
- MCP status endpoint `GET /agent/mcp/status` now returns `{ configuredCount, connectedCount, totalToolCount, lastLoadedAt, servers[] }` — richer than the previous `{ servers[] }` shape. `ExternalMcpRegistry.status()` computes all counts and records `loadedAt` after `loadFromEnv()` completes.
- Follow-up task file: `REMAINING_AGENT_TASKS.md` lists only non-production remaining work with copy-paste prompts for corpus embedding/resume/verification, MCP management polish, and tests.
- Corpus retrieval verified (Task 3): `/corpus/status` → `enabled: true, ready: true, pendingGames: 820`; pipeline is end-to-end functional (embed → Vectorize → Postgres → R2 → chunk injection). Ingested niche distribution: general(53), social(8), fps(3), simulator(3), rpg(2), horror(2), battle-royale(2), racing(1), tower-defense(1), obby(1), tycoon(1).
- Corpus retrieval calibration: added `"general": []` to `NICHE_KEYWORDS` in `server/agent/corpus/retrieve.ts` so `roblox-general` (53 games) participates in all-index fallback searches; also added `roblox-general` as a parallel secondary search alongside any niche-specific index query (`niche !== "general"` guard prevents double-search). This surfaces the 53 general-niche games that were previously never reachable.
- Corpus retrieval test results: "help me build a tycoon dropper income system" → 4 chunks from Mansion Tycoon (tycoon, scores 0.73–0.66); "make a shop GUI with coins" → 1 chunk from Project Pokemon (general, score 0.68); "create a gun damage system with server validation" → 4 chunks from Lasertag! + Martian Invasion (fps+general, scores 0.74–0.72). `CORPUS_LOG_RETRIEVAL=true` and `CORPUS_MIN_SCORE=0.50` remain in `.env`.

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


1. Fix MCP/plugin wording
2. Finish frontend login/logout UX
3. Audit Studio token ownership end-to-end
4. Run corpus metadata backfill
5. Do provider-key UI final cleanup
6. Set production env safely
7. Deploy with anonymous/dev mode disabled
8. Test full user flow:
   login → create Studio token → connect plugin → chat → agent edits Studio → logout
