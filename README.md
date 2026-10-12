# Corpus: an AI agent for Roblox Studio

Corpus is a "Cursor for Roblox". You chat with an agent; it reads and edits your
place **inside Roblox Studio** (scripts, instances, properties, DataStores), asks
before risky changes, and grounds its code in a searchable corpus of real
open-source Roblox games.

- Landing + setup guide: https://corpus-landing-chi.vercel.app
- Demo video: _add link_

## How it works

```
Browser chat UI (React + Vite)
        │  HTTP / SSE
        ▼
Bridge server (Bun + Express)  ── agent runtime, tools, approvals, retrieval
        ▲
        │  long-poll (Studio can only make outbound requests)
Roblox Studio plugin (Luau) ── executes each tool call locally, undo waypoints
```

- **Agent runtime** (`server/agent/`): run lifecycle, tool scheduler, plan mode,
  permission policy, recovery from failed tool calls, subagents, context compaction.
- **Studio plugin** (`studio-plugin/`): polls the bridge, runs tool calls
  (read/write/edit scripts, create/move/delete instances, set properties,
  playtest, logs) and returns results.
- **Corpus retrieval** (`server/agent/corpus/`): open-source Roblox places are
  decoded from `.rbxl`, chunked per game, embedded, and stored in niche-sharded
  Cloudflare Vectorize indexes (text in R2, metadata in Postgres). Ingestion is
  rolled back on failure so a run never leaves a half-written index.
- **Auth + state**: Prisma/Postgres (users, sessions, Studio tokens, conversations).

## Run it locally

You need [Bun](https://bun.sh), Roblox Studio and an OpenRouter key.

```bash
bun install
printf 'OPENROUTER_API_KEY=sk-or-...\nCORPUS_ALLOW_ANONYMOUS=true\nCORPUS_COOKIE_SECURE=false\n' > .env
bun run dev          # UI on :5173, bridge on :3001
```

Then install `public/studio-plugin/` (or `studio-plugin/corpus-bridge.server.lua`)
into your Roblox Plugins folder, enable **Allow HTTP Requests** for your place,
generate a Studio token in the app, paste it into the plugin, and connect.
Step-by-step guide: https://corpus-landing-chi.vercel.app/guide

Optional: set `DATABASE_URL` for Postgres storage and the `CLOUDFLARE_*` keys
plus `CORPUS_ENABLED=true` for corpus retrieval (see `.env.example`).

## Self-hosting

A `Dockerfile` builds the UI and runs the bridge as one process (sessions are
held in memory, so run a single instance). Set `NODE_ENV=production`,
`DATABASE_URL`, `CORPUS_COOKIE_SECURE=true` and `CORPUS_ALLOW_ANONYMOUS=false`.

## Repo map

| Path | What |
|---|---|
| `src/` | React chat UI, stores, approval/diff components |
| `server/` | Bridge, agent runtime, tools, Discord adapter |
| `studio-plugin/` | Roblox Studio plugin (Luau) |
| `scripts/` | `.rbxl` conversion, ingestion and embedding tooling |
| `prisma/` | Schema and migrations |
| `knowledge-base/` | Design docs (orchestration loop, RAG pipeline, protocols) |
