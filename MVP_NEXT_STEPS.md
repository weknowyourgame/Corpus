# Stud MVP Next Steps

This document is the product-ready MVP build plan for Stud.

MVP means a Roblox developer can install Stud, connect Roblox Studio, ask for a safe script or instance change, approve risky actions, see what happened, and recover when something breaks.

## MVP Architecture Decision

For MVP, commit to one primary runtime path:

```txt
Hosted Stud web/server
  -> Stud Roblox Studio plugin (`stud-bridge.server.lua`)
  -> token-authenticated long polling
  -> AI agent tool calls
  -> live Roblox Studio changes
```

Defer or treat as legacy/reference:

- `studio-rust-mcp-server/`
- Official/local Roblox Studio MCP transport UI
- Cloud MCP as a multi-client platform
- Tauri desktop wrapper as a required install path
- Corpus/RAG as a launch blocker

## MVP Must-Haves

### 1. Stable Install And Connect Flow

- Web app exposes the plugin download clearly.
- Studio plugin accepts a Stud token and connects.
- UI shows connected/disconnected with accurate wording.
- Reconnect works after Studio, plugin, browser, or server restart.
- Remove confusing "official MCP" labels unless that transport is truly wired.

Acceptance checks:

- Fresh user can download plugin from the app.
- Fresh user can paste token in Studio and see "connected" in the app.
- Stopping Studio changes UI to disconnected or waiting.
- Reopening Studio/plugin reconnects without creating a confusing duplicate session.

Prompt to run:

```txt
Read CODEBASE.md first. Implement the MVP connection polish for Stud. Treat the Stud Roblox Studio polling plugin as the only active MVP transport. Remove or hide misleading "official MCP" UI wording unless it is backed by active server support. Add/adjust UI copy so users can clearly see: server reachable, plugin connected, last poll time if available, token/session invalid, and waiting for Studio. Keep changes scoped, update tests where useful, and update CODEBASE.md after the run.
```

### 2. Basic Chat Agent End-To-End

- User sends a prompt from the web UI.
- Server creates an agent run.
- Model streams response and tool calls.
- Tool calls execute through the plugin relay.
- Tool results stream back.
- Completed and failed runs show clear final state.

Acceptance checks:

- A simple "what is selected?" prompt calls `get_selection`.
- A simple "list Workspace children" prompt calls `list_children`.
- A model/API failure displays a useful message.
- A plugin timeout displays a useful message.

Prompt to run:

```txt
Read CODEBASE.md first. Audit and harden the chat-agent run path from src/lib/ai/server-agent.ts through server/agent/runtime.ts and server/index.js. Focus on MVP reliability: streaming events, run completion, tool result display, clear failure states, and plugin timeout handling. Do not add new feature areas. Add focused tests if existing patterns allow. Update CODEBASE.md after the run.
```

### 3. Core Studio Tool Set

MVP tools:

- `get_selection`
- `list_children`
- `search_instances`
- `read_script`
- `write_script`
- `edit_script`
- `create_instance`
- `set_property`
- `delete_instance`

Defer unless already stable:

- Asset insertion
- Bulk operations
- Arbitrary runtime Luau
- Advanced playtest automation
- DataStore mutation tools

Acceptance checks:

- Each MVP tool works through the plugin relay.
- Each MVP tool has a readable UI result.
- Each mutating MVP tool has an approval/risk path.

Prompt to run:

```txt
Read CODEBASE.md first. Verify and harden only the MVP Roblox Studio tools: get_selection, list_children, search_instances, read_script, write_script, edit_script, create_instance, set_property, and delete_instance. Check server/agent/tools.ts, server/agent/studio-transport.ts, and studio-plugin/stud-bridge.server.lua for naming/schema mismatches. Add smoke tests or unit tests around schema/routing where practical. Update CODEBASE.md after the run.
```

### 4. Safe Script Editing

- Agent reads before writing.
- Conflict detection prevents overwriting user changes.
- Script writes and edits create undo waypoints in Studio.
- UI shows what changed.
- Failed edits do not silently corrupt source.

Acceptance checks:

- Create a script in `ServerScriptService`.
- Edit that script.
- Reject an edit conflict if the source changed after last read.
- Undo in Studio restores the previous source.

Prompt to run:

```txt
Read CODEBASE.md first. Make script editing MVP-safe. Inspect server/agent/tools.ts, conflict/revision tracking, MutationDiff/DiffView UI, and the Stud Studio plugin write/edit handlers. Ensure read-before-write, conflict reporting, undo waypoint metadata, and visible diff/result display work together. Keep the existing architecture. Add focused tests for conflict/edit behavior. Update CODEBASE.md after the run.
```

### 5. Approval Gates

MVP approval policy:

- Read-only tools are auto-allowed.
- Script writes/edits require visible approval or a clearly approved scope.
- Delete requires approval.
- Runtime code execution requires approval.
- External asset insertion is disabled or requires strong approval.

Acceptance checks:

- Delete prompt asks before deleting.
- Rejecting approval prevents the tool call.
- Approval UI says what will happen in human language.
- Approved scopes do not accidentally allow unrelated dangerous actions.

Prompt to run:

```txt
Read CODEBASE.md first. Harden MVP approvals. Review server/agent/policy.ts, runtime approval flow, ApprovalPrompt UI, and tool risk classifications. Ensure reads are smooth, writes/deletes/runtime code/external assets are gated, rejected approvals stop execution, and approval copy is human-readable. Add tests for allow/ask/deny behavior and rejected approvals. Update CODEBASE.md after the run.
```

### 6. Model And Provider Setup

- Pick one recommended default path.
- Missing API key state is obvious.
- Model picker does not overwhelm first-time users.
- Server and frontend agree on model/provider configuration.

Acceptance checks:

- With no key configured, chat tells user exactly what to configure.
- With a valid key, a trivial no-tool prompt works.
- A bad key returns a clear provider error.

Prompt to run:

```txt
Read CODEBASE.md first. Polish MVP model/provider setup. Review src/stores/settings.ts, src/stores/models.ts, ModelSelector, SettingsDialog, server/agent/ai-config.ts, drivers.ts, and gateway-driver.ts. Choose/mark a recommended default path, make missing/bad API key errors clear, and hide confusing advanced choices where appropriate for MVP. Update tests and CODEBASE.md after the run.
```

### 7. First-Run Onboarding

The first-run path should be:

1. Install/download plugin.
2. Open Roblox Studio.
3. Paste/connect Stud token.
4. Configure model/API key.
5. Run a harmless Studio test command.
6. Start chatting.

Acceptance checks:

- A new user can complete setup without reading the repo.
- Each failed setup step has recovery instructions.
- Onboarding detects connected state and does not keep blocking.

Prompt to run:

```txt
Read CODEBASE.md first. Build or polish the MVP first-run onboarding flow. Use the existing prereq components/stores. The flow should cover plugin install/download, opening Studio, token connect, model/API key setup, and a harmless connection test command. Make recovery messages concrete. Do not redesign the whole app. Update CODEBASE.md after the run.
```

### 8. Error Handling

Required clear errors:

- Plugin not connected.
- Invalid/expired token.
- Model API key missing.
- Provider rejected request.
- Tool timeout.
- Studio command failed.
- Approval rejected.
- Edit conflict.
- Server unavailable.

Acceptance checks:

- Each error becomes a user-visible message.
- The app does not spin forever.
- The next run can proceed after the issue is fixed.

Prompt to run:

```txt
Read CODEBASE.md first. Audit MVP error handling across frontend chat state, server agent runtime, plugin relay, and Studio status endpoints. Make plugin disconnects, invalid token, missing model key, provider errors, tool timeout, Studio command failure, rejected approval, edit conflict, and server unavailable states visible and recoverable. Add focused tests around state transitions where practical. Update CODEBASE.md after the run.
```

### 9. Basic Persistence And Audit

Minimum:

- Conversation survives refresh enough to continue.
- Completed tool calls remain visible.
- Current session audit log records tool name, risk, input summary, result/error, approval decision, and timestamp.

Acceptance checks:

- Refresh after a completed run does not erase the conversation.
- Failed run still shows what failed.
- User can inspect what Stud changed during the session.

Prompt to run:

```txt
Read CODEBASE.md first. Implement MVP persistence/audit hardening. Review server/agent/store.ts, runtime audit log, frontend chat store hydration, and event rendering. Ensure conversations/tool calls survive refresh enough for MVP and expose a readable current-session audit trail. Keep storage simple and consistent with existing file-based store unless a migration is truly needed. Update CODEBASE.md after the run.
```

### 10. Production Deployment Path

One clear MVP deployment target should be documented and working.

Required:

- Build commands.
- Start commands.
- Environment variables.
- Health/status endpoints.
- Plugin download URL.
- Token/session behavior.
- Database migration commands if Postgres is enabled.
- Cloudflare/R2/Vectorize are optional unless corpus is enabled.

Acceptance checks:

- Fresh deploy can serve the web app.
- Server starts with required env.
- Plugin can connect to hosted URL.
- Corpus disabled does not break core chat/Studio loop.

Prompt to run:

```txt
Read CODEBASE.md first. Create a production deployment pass for the MVP. Document and verify build/start commands, required env vars, health/status endpoints, plugin download URL, token/session behavior, and database migration commands. Ensure corpus/R2/Vectorize are optional and do not block the core Studio agent path when disabled. Update README/AI_SETUP or add a deployment doc as appropriate, and update CODEBASE.md after the run.
```

## Database And Storage MVP Notes

### Current Database Usage

- `prisma/schema.prisma` defines core app tables (`agent_conversations`, `agent_events`, `studio_tokens`) plus corpus tables (`games`, `chunks`).
- `server/agent/store.ts` defaults to Postgres for agent conversations/events when `DATABASE_URL` exists.
- `STUD_AGENT_STORE=file` keeps the old `.stud/agent-conversations` fallback; `STUD_AGENT_STORE=memory` is for tests/dev-only sessions.
- Studio plugin tokens are stored in `studio_tokens` when `DATABASE_URL` exists, with the old `server/studio-tokens.json` behavior only used as a no-DB local fallback.
- Postgres now backs core conversation/run/event/audit persistence. R2/Vectorize are still optional and only needed for corpus retrieval.

### MVP Database Decision

For MVP, keep database scope conservative:

- Core Studio agent loop should use Postgres in production.
- Core Studio agent loop should still work with corpus disabled.
- If Postgres is unavailable in local dev, use `STUD_AGENT_STORE=file`.
- Do not make Vectorize/R2 required for basic chat and Studio edits.
- Add migrations only when a real product feature needs relational storage.

### Future Product Tables To Consider

Already added:

- `agent_conversations`
- `agent_events`
- `studio_tokens`

Add only when needed:

- `users`
- `studio_sessions`
- `tool_calls` as a normalized table if JSON audit snapshots become too hard to query
- `approval_decisions` as a normalized table if product analytics/audit search needs it

Prompt to run:

```txt
Read CODEBASE.md first. Audit database/storage requirements for MVP. Determine which features currently require Postgres and which use file/local/browser storage. Produce a clear recommendation and, only if necessary, implement minimal schema/storage changes for users, sessions, conversations, runs, tool calls, approvals, or audit events. Keep corpus tables separate from core app needs. Update CODEBASE.md after the run.
```

## MVP Smoke Test Suite

Run these before calling MVP ready.

### Fresh User Connect

```txt
Open app -> download/install plugin -> open Roblox Studio -> paste token -> app shows connected.
```

### Read-Only Studio Task

Prompt:

```txt
What scripts are in ServerScriptService?
```

Expected:

- Agent lists children.
- Reads scripts only if needed.
- Answers correctly.

### Script Creation Task

Prompt:

```txt
Create a Script in ServerScriptService named StudHello that prints hello when the game starts.
```

Expected:

- Agent creates Script.
- Agent writes source.
- Studio actually contains the script.
- UI shows tool calls/results.

### Script Edit Task

Prompt:

```txt
Change StudHello's print message to "Stud is connected".
```

Expected:

- Agent reads script.
- Agent edits script.
- Diff/result is visible.
- Undo works in Studio.

### Destructive Approval

Prompt:

```txt
Delete StudHello.
```

Expected:

- App asks approval.
- Approval deletes.
- Rejection does not delete.

### Failure Recovery

```txt
Disconnect plugin mid-run -> app shows clear failure -> reconnect plugin -> next run works.
```

### API Key Missing

```txt
Remove model key -> send prompt -> app clearly asks user to configure key.
```

### Refresh Recovery

```txt
Complete a run -> refresh browser -> conversation/tool history remains enough to continue.
```

Prompt to run:

```txt
Read CODEBASE.md first. Build an MVP smoke-test checklist or automated test harness for the core flow: fresh connect, read-only Studio task, script creation, script edit, destructive approval, plugin disconnect recovery, missing API key, and refresh recovery. Prefer tests where the repo already has patterns; otherwise create a manual QA checklist with exact steps. Update CODEBASE.md after the run.
```

## Recommended Build Order

1. Clarify active MVP architecture and remove misleading transport UI.
2. Connection Doctor and test command.
3. Core Studio tool smoke pass.
4. Safe script edit and diff/result UI.
5. Approval gates.
6. Error handling pass.
7. First-run onboarding.
8. Basic persistence/audit.
9. Production deployment documentation.
10. MVP smoke tests.

## Deferred Until After MVP

- Corpus/RAG quality work.
- Vectorize/R2 ingestion scaling.
- Playtest automation beyond basic logs if unstable.
- DataStore mutation UX.
- Asset insertion safety workflow.
- Cloud MCP for Cursor/Claude.
- Tauri desktop packaging.
- Subagents and specialist modes.
- Large provider/model marketplace.
