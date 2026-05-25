# Phase 1 Server-Owned Agent Runtime

Date: 2026-05-25

## Implemented Boundary

Phase 1 moves the active chat execution path out of React and into the bridge process while retaining the existing UI layout and Studio plugin relay.

| Capability | Implementation evidence | Validation |
| --- | --- | --- |
| Typed conversations, runs, messages, and events | `server/agent/types.ts` | Server type check passes. |
| Persistent development transcript and replay log | `server/agent/store.ts` stores JSON snapshots in `.stud/agent-conversations/`; `.gitignore` excludes `.stud/` | Replay unit test passes. |
| Stateful bounded model/tool loop | `server/agent/runtime.ts` appends user, assistant, and structured tool messages and bounds the loop at ten iterations | Multi-turn tool continuation unit test passes. |
| Cancellation | `server/agent/runtime.ts` owns an `AbortController` per active run; `POST /agent/conversations/:id/runs/:runId/cancel` aborts it | Cancellation unit test passes. |
| SSE stream and event replay | `server/agent/routes.ts` exposes `GET /agent/conversations/:id/events?after=<sequence>` with SSE ids and keep-alives | Replay unit test covers the persisted cursor behavior. |
| Server-side model calls | `server/agent/drivers.ts` creates Anthropic/OpenRouter AI SDK clients from server environment variables and a server-side Codex stream driver | Type checked; paid/live provider calls not run locally. |
| Transitional server Studio tools | `server/agent/tools.ts` exposes the existing Roblox tool names and forwards Studio operations through `server/index.js` session relay | Source integrated; a live Studio mutation was intentionally not performed in local validation. |
| Run-scoped question responses | `roblox_ask_user` in `server/agent/tools.ts` emits `interaction_requested`; `src/lib/ai/server-agent.ts` posts the chosen answers to the run | Integrated into existing `QuestionPrompt` UI; not exercised against a live model. |
| React stream consumer | `src/pages/Home.tsx` calls `sendServerMessage()` and no longer starts browser provider/tool loops or installs `setAskUserHandler` | Frontend type check/build pass. |
| Server-provider setup and stable pairing UI | `src/stores/prereq.ts` checks `/agent/config`; `src/components/chat/ModelSelector.tsx` enables server-configured providers; `src/components/SessionCode.tsx` keeps a pairing code stable rather than invalidating the plugin every 30 seconds | Browser smoke test reached the connected chat view using a harmless poll heartbeat. |

## Reference Use

This implementation follows concepts inspected in `claude-code-opensource/QueryEngine.ts` and `claude-code-opensource/services/tools/StreamingToolExecutor.ts`: a conversation-owned lifecycle, structured tool-result continuation, iteration bounds, event-driven rendering, and abortable execution. No Claude Code module is imported or copied into the runtime because the provenance/license restriction in `docs/phase-0/architecture-decisions.md` remains in force.

`studio-rust-mcp-server/README.md`, `studio-rust-mcp-server/src/rbx_studio_server.rs`, and its MIT `LICENSE` were inspected. The Roblox repository itself recommends Studio's built-in MCP Server going forward. Phase 1 therefore keeps the existing relay operational; routing runtime tools through built-in MCP remains the Phase 2 connector migration, not a hidden Phase 1 claim.

## Local Run

Configure a server-owned provider in `.env` or your shell:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# or: export OPENROUTER_API_KEY="sk-or-..."
# or: export STUD_CODEX_ACCESS_TOKEN="..."
# optional Codex workspace/account routing:
# export STUD_CODEX_ACCOUNT_ID="..."
npm run dev
```

The web app runs at `http://localhost:5173`, and the TypeScript-enabled bridge/agent server runs at `http://localhost:3001`. Connect the existing Stud Studio plugin using the UI session code. The selected provider is enabled in the chat composer only when its corresponding server environment credential is present.

For a local shared machine, an optional guard can be configured:

```bash
export STUD_AGENT_API_KEY="local-dev-key"
export VITE_STUD_AGENT_API_KEY="local-dev-key"
npm run dev
```

The `VITE_` value is visible to the browser and is not production authentication. Hosted deployment still needs identity-bound authorization, secure credential storage, CSRF/origin controls, rate limiting, and a non-query-string SSE authentication design.

## API Shape

| Endpoint | Purpose |
| --- | --- |
| `GET /agent/config` | Reports which server providers are configured, without exposing credentials. |
| `POST /agent/conversations` | Creates a persisted conversation paired to a Studio session ID. |
| `GET /agent/conversations/:id` | Restores transcript/run state for UI refresh. |
| `POST /agent/conversations/:id/runs` | Adds a user turn and starts a model/tool run. |
| `GET /agent/conversations/:id/events?after=N` | Streams and replays sequenced run events. |
| `POST /agent/conversations/:id/runs/:runId/cancel` | Cancels a running request. |
| `POST /agent/conversations/:id/runs/:runId/interactions/:interactionId` | Answers `roblox_ask_user` for that run. |

## Validation Run

```bash
npm run typecheck
npm run test:run -- --reporter=dot
npm run build
```

Observed result on 2026-05-25: type checking passed; tests passed with 4 test files and 34 tests, including all three new agent runtime tests; the production Vite build passed with its existing large-chunk warning. The bridge HTTP smoke test created and retrieved server-owned configuration/conversation state, and a browser smoke pass reached the connected chat composer using a non-mutating mock plugin heartbeat. Live model API calls, live Studio mutations, and built-in Roblox MCP integration were not executed during this safe local validation.

## Deferred Before Hosted Beta

- The compatibility Studio registry still exposes mutations and `roblox_run_code` without the Phase 3 policy gate.
- The custom HTTP polling relay is still used until Phase 2 integrates and normalizes built-in Roblox Studio MCP tools.
- The older browser provider modules remain in source for settings/auth compatibility but are no longer the `Home` chat execution path; they should be removed or explicitly isolated once server account setup exists.
- Persisted development conversations are local JSON files, not tenant-isolated production storage.
