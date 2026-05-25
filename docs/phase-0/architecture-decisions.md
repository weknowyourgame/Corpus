# Phase 0 Architecture Decisions

Date: 2026-05-25

These decisions govern Phase 1 implementation and later Roblox capability work. They are intentionally narrow: Phase 1 establishes server-owned execution and stream recovery, but does not pretend that MCP, permissions, or hosted authentication are already solved.

## ADR-001: Agent Runs Are Server-Owned

**Status:** Accepted for Phase 1.

**Decision**

New Stud chat execution is owned by a Node/TypeScript server runtime. React submits messages and renders typed run events; it no longer owns the authoritative multi-turn tool continuation loop on the migrated path.

**Why**

- `src/lib/ai/providers.ts` and `src/lib/ai/codex-chat.ts` prove model/tool behavior, but browser execution cannot reliably enforce server policy or provide durable replay/cancellation.
- `claude-code-opensource/QueryEngine.ts` explicitly uses one stateful engine per conversation, carries mutable message history across turns, writes transcripts before waiting on model completion, and exposes abort control.
- `claude-code-opensource/query.ts` continues based on streamed tool-use events rather than a separate mandatory planner. That maps well to Roblox: improve tool/context/policy rather than add speculative orchestration first.

**Phase 1 shape**

- A typed runtime holds conversation messages, run state, event sequence, abort controller, and iteration bounds.
- A development file-backed store persists conversations and events; secrets are excluded.
- API routes create/list/get conversations, submit runs, stream/replay SSE events, and cancel a running run.
- The current UI styling is retained while the send path consumes typed server events.

**Known deferred issue**

Existing provider credentials are browser-local in `src/stores/settings.ts` and `src/lib/auth/codex.ts`. Phase 1 supports server environment credentials and temporary development pass-through of already existing frontend credentials. Full server credential ownership and user authentication remain required for hosting.

## ADR-002: Studio Will Be Exposed Through Roblox MCP, Not Reimplemented During Phase 1

**Status:** Accepted; implementation scheduled for Phase 2.

**Decision**

The existing session relay and Lua handler surface remain the development Studio transport while Phase 1 is built. The authoritative server tool runtime will use a connector boundary designed to integrate Roblox Studio's built-in MCP server in Phase 2. The added `studio-rust-mcp-server/` repository is used as a Roblox-owned reference, not as a reason to extend the custom relay indefinitely.

**Why**

- Current useful functionality already exists in `src/lib/roblox/tools.ts`, `server/index.js`, and `studio-plugin/stud-bridge.server.lua`.
- Replacing the bridge simultaneously with the conversation runtime would hide regressions and delay a working migrated UI.
- `claude-code-opensource/services/mcp/client.ts` and `tools/MCPTool/` demonstrate the eventual contract: MCP tools appear as namespaced normal tools, are schema validated, called with timeouts/progress, and normalize structured results into the main loop.
- `studio-rust-mcp-server/README.md` identifies Roblox Studio's built-in MCP server as Roblox's recommended direction. Its MIT-licensed reference source demonstrates an `rmcp` stdio server plus Studio relay and tool shapes in `src/rbx_studio_server.rs`.

**Required Phase 2 contract**

- Prefer discovery/integration of Roblox Studio's built-in MCP tools and normalize them to `mcp__roblox_studio__*` operations within Stud.
- Read tools are parallelizable; mutations are serialized and permission checked.
- Calls carry stable IDs, cancellation/timeout status, presence, and mutation idempotency.
- The current polling plugin can remain as a compatibility fallback until the built-in MCP path covers required functionality.

## ADR-003: Claude Code Is a Reference Architecture Pending Provenance Verification

**Status:** Accepted with restriction.

**Decision**

Use `claude-code-opensource/` to learn behavior and interface design, and independently implement the minimum Stud equivalents. Do not copy or depend on imported source modules unless provenance and license compatibility are confirmed.

**Inspection finding**

- The directory contains rich TypeScript implementation sources including `QueryEngine.ts`, `query.ts`, `Tool.ts`, `services/tools/StreamingToolExecutor.ts`, `services/mcp/`, and `tools/AgentTool/`.
- It also contains non-portable build/environment coupling such as `bun:bundle` imports and `src/...` internal module aliases.
- During Phase 0 inspection, no license or package manifest was found at the imported directory root that establishes redistribution or derivative-work terms for that source snapshot.
- Stud's repository `LICENSE` is AGPL-3.0, but that does not by itself establish rights to imported third-party source.

**Patterns explicitly adopted, independently implemented**

| Claude Code pattern inspected | Stud Phase 1 use |
| --- | --- |
| `QueryEngine` conversation lifetime and abort controller | One runtime conversation object persisted across runs, with abortable active execution |
| `query.ts` streamed tool-result continuation with turn cap | Server loop streams deltas/tool events, executes registered tools, appends results, and stops on no requested tools or iteration limit |
| `utils/sessionStorage.ts` transcript persistence before a run completes | Development conversation/event persistence supporting UI replay after reconnect |
| `Tool.ts` tool metadata boundary | Minimal typed executor boundary now; full risk/permission metadata in Phase 3 |
| `StreamingToolExecutor` distinction between parallel-safe and mutating work | Preserve as a Phase 2/3 connector requirement; Phase 1 executes requested tools conservatively in order |

**Not copied in Phase 1**

- Terminal/Ink UI.
- Filesystem/shell tooling.
- Claude-specific model and feature-flag infrastructure.
- MCP implementation source.
- Permission, plan, or subagent modules.

## ADR-004: Phase 1 Tool Surface Is Transitional

**Status:** Accepted.

**Decision**

To make the migrated chat path functional before MCP, Phase 1 provides a server-owned compatibility registry for existing Roblox Studio operations. It forwards typed tool calls into the existing session relay. This registry is not the final authorization boundary.

**Rules**

- Mark the registry as transitional in code/docs.
- Do not add DataStore or publish tools through it.
- Do not claim Phase 1 makes live mutations safe; Phase 3 permission enforcement is mandatory before production mutation use.
- Preserve structured event records so future permission/MCP work can wrap execution without changing the browser event protocol.

## ADR-005: Stream Protocol and Development Persistence

**Status:** Accepted for Phase 1.

**Decision**

Use server-sent events for one-way run/event delivery and standard HTTP for submitting/cancelling runs. Persist conversation snapshots and sequenced events under a gitignored local development directory.

**Why**

- Tool execution and text deltas naturally flow server-to-browser; user sends remain request/response interactions.
- SSE supports reconnect with event sequence replay and is sufficient before approval interaction endpoints arrive.
- A file-backed adapter keeps development simple and makes the persistence boundary explicit; production storage remains replaceable.

**Minimum event types**

`run_started`, `text_delta`, `tool_call`, `tool_result`, `run_completed`, `run_cancelled`, and `run_error`.

**Validation required**

- Multi-turn model/tool/model continuation test.
- Event replay from sequence cursor test.
- Cancellation test with an abort-aware model or tool.
