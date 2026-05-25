# Phase 2 Roblox Studio MCP Gateway

Date: 2026-05-25

## Implemented Boundary

The server agent no longer consumes the browser Roblox executor surface. `server/agent/tools.ts` now presents Studio operations as typed, namespaced tools such as `mcp__roblox_studio__list_children`, `mcp__roblox_studio__create_instance`, `mcp__roblox_studio__execute_luau`, and `mcp__roblox_studio__insert_asset`.

For the current demo transport, these MCP-shaped tools map to the existing paired-session HTTP relay in `server/index.js` and handlers in `studio-plugin/stud-bridge.server.lua`. This preserves the installed plugin and its polling requirement while making the server runtime, permissions, and audit trail independent of browser tool executors.

## Transport Guarantees

| Requirement | Implementation evidence | Test status |
| --- | --- | --- |
| Namespaced typed tool listing | `RobloxStudioMcpGateway` in `server/agent/tools.ts` | `server/agent/toolbox.test.ts` passes. |
| Session pairing and presence | `/stud/sessions/:sessionId/status` and `/poll` in `server/index.js`; plugin poll loop in `studio-plugin/stud-bridge.server.lua` | Existing browser heartbeat smoke test; non-mutating only. |
| Timeout/cancellation | Relay timeout and response-close cancellation removal in `server/index.js`; runtime abort in `server/agent/runtime.ts` | `server/agent/relay.integration.test.ts` and `runtime.test.ts` pass. |
| Mutation idempotency | Operation ID is derived from run/tool-call ID; completed relay responses are cached for five minutes in `server/index.js` | Mock plugin poll/respond/retry test passes. |
| Raw relay mutation bypass prevention | `server/index.js` permits mutating request paths only with its private gateway header while leaving UI-required reads compatible | Integration test rejects an unauthenticated direct create request. |
| Undo boundary | Plugin `modifyingPaths` wraps modifying endpoints with Studio waypoints in `studio-plugin/stud-bridge.server.lua` | Source inspected; live mutation not performed in safe validation. |

## Official Roblox MCP Direction

Roblox documents a built-in Studio MCP Server enabled through Studio beta features and invoked on macOS through `StudioMCP --stdio`: [Roblox Studio MCP documentation](https://create.roblox.com/docs/studio/mcp). The local installation was checked and `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` is present.

The repository also contains `studio-rust-mcp-server/README.md` and `studio-rust-mcp-server/src/rbx_studio_server.rs`; that MIT reference server itself points users toward Roblox Studio's built-in server.

The implemented gateway is deliberately a compatibility adapter over the working Stud plugin, as required by `plan.md` Phase 2. A production deployment may replace its relay transport with Roblox's built-in stdio MCP client without changing policy-facing names or the React event protocol. Direct built-in MCP calls have not been claimed as locally validated in this phase.
