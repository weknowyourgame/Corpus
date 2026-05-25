# Phase 0 Capability Matrix

Date: 2026-05-25

## Status Legend

| Status | Meaning |
| --- | --- |
| Tested | Executed in this repository during Phase 0 and produced the expected local result. |
| Inspected | An implementation path exists in source, but it was not exercised against a live Roblox Studio session or live provider in Phase 0. |
| Partial | Some necessary pieces exist, but the production or end-to-end contract is incomplete. |
| Missing | No implementation matching the product requirement was found. |
| Failed | A safe Phase 0 validation was run and failed. |

Phase 0 deliberately does not cause mutations in a creator's Roblox place or call paid model/provider APIs. For that reason, Studio actions and live AI calls are `Inspected` unless a later integration fixture exercises them.

## Baseline Validation

| Check | Status | Result |
| --- | --- | --- |
| Unit suite | Tested | `npm run test:run -- --reporter=dot` passed: 3 test files, 31 tests. Existing tests cover model-store behavior and Codex browser token storage/helpers, not Studio tool execution. |
| Production frontend build | Tested | `npm run build` passed. Vite reports large output chunks, including a main JS chunk above 1 MB, which is a performance follow-up rather than a Phase 1 blocker. |
| Bridge syntax | Tested | `node --check server/index.js` passed before the Phase 1 server changes. |

## User Flow Matrix

| Creator flow | Status at Phase 0 baseline | Evidence in source | Gap before beta |
| --- | --- | --- | --- |
| Load web chat UI and connection screen | Inspected | `src/pages/Home.tsx` renders `ConnectionScreen`, chat composer, message stream, and settings; `src/stores/roblox.ts` polls bridge status. | No automated browser flow test. |
| Generate/copy a pairing code | Inspected | `src/lib/bridge/session.ts` creates and stores an eight-character browser-local session ID; `src/components/SessionCode.tsx` presents it. | Session code is not authenticated or tied to a user/project. |
| Plugin connects to bridge | Inspected | `studio-plugin/stud-bridge.server.lua` stores the session ID, polls `/stud/sessions/:id/poll`, and posts responses; `server/index.js` owns the in-memory queue. | No live Studio validation; polling state is volatile across bridge restarts. |
| Stream a chat response from Anthropic/OpenRouter | Inspected | `src/lib/ai/providers.ts` calls AI SDK `streamText()` from the browser and forwards text/tool events. | Provider keys and agent authority remain browser-side at baseline. |
| Stream a Codex response | Inspected | `src/lib/ai/codex-chat.ts` performs a bounded tool loop and proxies upstream requests through `/codex/responses`; browser OAuth helpers live in `src/lib/auth/codex.ts`. | OAuth access/refresh credentials are browser-held; no live provider call in Phase 0. |
| Read a Studio script | Inspected | `src/lib/roblox/tools.ts` exports `roblox_get_script`; `studio-plugin/stud-bridge.server.lua` handles `/script/get`. | No typed server-owned connector or live test. |
| Modify a Studio script | Inspected | `roblox_set_script` and `roblox_edit_script` call `/script/set` and `/script/edit`; plugin uses `ScriptEditorService:UpdateSourceAsync` and sets undo waypoints. | No policy gate or source-revision conflict detection. |
| Inspect/create/edit/move/delete instances | Inspected | `src/lib/roblox/tools.ts` defines instance and bulk tools; the plugin implements `/instance/*` handlers. | Mutations may execute immediately at model request; delete/bulk safety is prompt-only. |
| See/choose the current selection | Inspected | `roblox_get_selection` and `/selection/get`; `src/components/chat/InstancePicker.tsx` and `InstanceTree.tsx` browse paths. | `@path` currently inserts text; it does not inject resolved live context into the model turn. |
| Ask the creator an interactive question | Partial | `roblox_ask_user` in `src/lib/roblox/tools.ts` waits on `setAskUserHandler`; `QuestionPrompt.tsx`, `src/stores/chat.ts`, and `Home.tsx` render/respond. | In-memory browser callback only; it is not persistent, reconnectable, or an enforced mutation approval. |
| Search Toolbox with thumbnails | Partial | `src/lib/roblox/toolbox.ts` queries Roblox catalog/details and thumbnails; `roblox_toolbox_search` returns rich choice objects; `QuestionPrompt.tsx` renders image options. | Not tested live; API calls and decision flow are browser-side; ranking/pagination and server auditing are incomplete. |
| Insert a chosen Toolbox asset | Partial | `roblox_insert_asset` calls `/asset/insert`; the plugin loads an asset with `InsertService`/`GetObjects` and creates undo points. | Inserted assets are not screened for scripts or dangerous descendants before entering the place. |
| Execute arbitrary Luau | Inspected, blocked for product safety | `roblox_run_code` calls plugin `/code/run`, which evaluates supplied source with `loadstring`. | Must be permission-gated or replaced by narrower typed operations before production use. |
| Plan first, then approve execution | Missing | `Home.tsx` adds a textual `[Create a detailed plan before making changes]` chip prefix only. | Requires actual runtime plan state and enforced read-only/mutation boundary. |
| Enforce mutation permissions | Missing | `appSettings.confirmDestructiveActions` exists in `src/stores/settings.ts`, but Studio tool execution does not consult an enforced server policy. | Requires permission engine and audit trail. |
| Query or update Roblox DataStores | Missing | No DataStore/Open Cloud tool or credential gateway found in `src/lib`, `server`, or `studio-plugin`. | Requires server-only Open Cloud implementation and approvals. |
| Delegate to subagents | Missing | No Stud runtime child-task implementation found; reference implementation exists only under `claude-code-opensource/tools/AgentTool/`. | Requires server-owned base loop first. |
| MCP-mediated Studio tools | Missing | Current connector is custom HTTP relay in `server/index.js` and the Lua plugin. | Requires an MCP gateway/adapter in a later phase. |
| Playtest/observe/fix loop | Missing | No Studio playtest, log capture, or structured verification handlers found. | Requires MCP/plugin extension after mutation governance. |

## Existing Roblox Tool Inventory

The baseline model-facing registry in `src/lib/roblox/tools.ts` exports 18 tools:

| Group | Tools |
| --- | --- |
| Scripts | `roblox_get_script`, `roblox_set_script`, `roblox_edit_script` |
| Instances | `roblox_get_children`, `roblox_get_properties`, `roblox_set_property`, `roblox_create`, `roblox_delete`, `roblox_clone`, `roblox_search`, `roblox_get_selection`, `roblox_run_code`, `roblox_move` |
| Bulk | `roblox_bulk_create`, `roblox_bulk_delete`, `roblox_bulk_set_property` |
| Toolbox | `roblox_toolbox_search`, `roblox_insert_asset` |
| Interaction | `roblox_ask_user` |

The matching mutation/read handlers are implemented in `studio-plugin/stud-bridge.server.lua` under its `handlers` table. This is enough for a prototype; it is not yet a governed hosted-agent surface.

## Added Roblox MCP Reference

`studio-rust-mcp-server/` was added during Phase 0/1 work and inspected. It is a Roblox-owned MIT-licensed reference implementation, not yet wired into Stud. Its `README.md` states that active investment has shifted to the built-in MCP Server included with Roblox Studio, which should be evaluated as the preferred production connector.

The repository still provides useful inspected evidence: `src/rbx_studio_server.rs` exposes MCP tools for `run_code`, `insert_model`, `get_console_output`, `start_stop_play`, `run_script_in_play_mode`, and `get_studio_mode`, while `plugin/src/Main.server.luau` shows its Studio-side request and change-recording path. Phase 2 should therefore integrate Roblox MCP rather than invent a new MCP protocol.

## Phase 1 Acceptance Target

Phase 1 is considered complete when the current chat UI can submit through a server-owned run endpoint, receive typed streamed run/tool events, persist a development transcript, resume/replay events after stream reconnect, cancel an in-flight run, and pass automated tests for tool continuation, event replay, and cancellation. Moving Studio operations behind MCP and implementing enforced mutation approvals remain later phases.
