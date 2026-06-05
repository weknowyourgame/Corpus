# Cloud MCP Plan

## Goal

Corpus should run as a cloud MCP server. Users install the Roblox Studio plugin once, paste a Corpus token once, and then any connected client can modify their local Studio through Corpus Cloud.

No local Node bridge. No session code flow. No official local StudioMCP dependency. The Corpus plugin is the only local executor.

## Final Architecture

```txt
Web App / Cursor / Claude
        |
        | HTTPS MCP / Corpus API
        v
Corpus Cloud
  - auth
  - MCP server
  - Studio connection registry
  - operation queue
  - approvals
        |
        | plugin long-poll + respond
        v
Roblox Studio Plugin
  - stores Studio token
  - polls cloud
  - executes tool calls locally
  - returns results
```

## Why This Is Better

- Users do not run a local bridge server.
- Studio connects outbound, so it works behind NAT/firewalls.
- One cloud MCP endpoint can serve the web app, Cursor, Claude, and future clients.
- Tool execution is still local and real-time inside Roblox Studio.
- Auth, approvals, logs, rate limits, and billing can live in one cloud backend.
- The plugin protocol becomes stable and small: poll, execute, respond.

## How It Works

1. User logs into Corpus.
2. Corpus Cloud creates a Studio token.
3. User pastes the token into the Roblox Studio plugin.
4. Plugin stores it with `plugin:SetSetting("StudioToken", token)`.
5. Plugin long-polls Corpus Cloud:

```txt
GET /studio/poll
Authorization: Bearer <studio_token>
```

6. Cloud returns either no work:

```json
{ "id": null }
```

or a tool call:

```json
{
  "id": "op_123",
  "tool": "write_script",
  "arguments": {
    "path": "game.ServerScriptService.Main",
    "source": "print('hello')"
  }
}
```

7. Plugin executes the tool locally.
8. Plugin responds:

```txt
POST /studio/respond
Authorization: Bearer <studio_token>
```

```json
{
  "id": "op_123",
  "result": {
    "path": "game.ServerScriptService.Main"
  },
  "isError": false
}
```

9. Cloud resolves the waiting MCP `tools/call`.

## Keep

- `server/agent/runtime.ts`
- `server/agent/routes.ts`
- `server/agent/tools.ts`
- `server/agent/policy.ts`
- `server/agent/types.ts`
- `server/agent/store.ts`
- `server/agent/drivers.ts`
- `studio-plugin/corpus-bridge.server.lua`
- web chat UI
- approval UI
- token UI

## Remove Or Ignore

- local session-code bridge flow
- `/corpus/sessions/:id/*`
- `/corpus/request`, `/corpus/poll`, `/corpus/respond`
- `public/studio-plugin/corpus-bridge.server.lua`
- `server/agent/mcp-stdio.ts`
- `OfficialMcpTransport`
- `CompositeStudioTransport`
- `CORPUS_STUDIO_TRANSPORT`
- `CORPUS_STUDIO_MCP_BINARY`
- `studio-rust-mcp-server/`
- path-based plugin protocol: `/script/get`, `/instance/create`, etc.

## New Cloud Protocol

Use tool names everywhere.

Old:

```json
{
  "request": {
    "path": "/script/set",
    "body": "{\"path\":\"game.X\",\"source\":\"...\"}"
  }
}
```

New:

```json
{
  "id": "op_123",
  "tool": "write_script",
  "arguments": {
    "path": "game.X",
    "source": "..."
  }
}
```

## Tool Names

```txt
ping
read_script
write_script
edit_script
list_children
get_properties
set_property
create_instance
delete_instance
clone_instance
move_instance
search_instances
get_selection
execute_luau
bulk_create
bulk_delete
bulk_set_property
inspect_asset
insert_asset
start_playtest
stop_playtest
get_logs
get_diagnostics
```

## Implementation Steps

1. Replace path-based relay with tool-name relay.
2. Change `server/agent/tools.ts` from `endpoint` to `mcpTool`.
3. Delete official local MCP transport code from the active server path.
4. Make `/studio/poll` token-authenticated and return `{ id, tool, arguments }`.
5. Make `/studio/respond` token-authenticated and accept `{ id, result, isError, error }`.
6. Store Studio tokens hashed in a DB, not plaintext JSON.
7. Track active Studio connections by `userId` and `studioId`.
8. Add operation queue with timeout, dedupe, and reconnect handling.
9. Add `server/agent/mcp-server.ts`.
10. Add MCP endpoints:

```txt
GET /mcp
POST /mcp
GET /mcp/info
```

11. MCP `tools/list` returns the Roblox tool list.
12. MCP `tools/call` enqueues work for the authenticated user's active Studio.
13. Web chat uses the same internal relay as MCP.
14. Add version field to plugin poll:

```json
{
  "pluginVersion": "1.0.0",
  "capabilities": ["tool-protocol-v1"]
}
```

15. Add clear user errors:

```txt
Studio not connected
Token expired
Operation timed out
Approval required
Plugin version unsupported
```

## Minimal Data Model

```txt
users
  id
  email
  created_at

studio_tokens
  id
  user_id
  token_hash
  name
  revoked_at
  created_at
  last_used_at

studio_connections
  id
  user_id
  studio_id
  plugin_version
  capabilities
  last_poll_at
  status

studio_operations
  id
  user_id
  studio_id
  tool
  arguments_json
  status
  result_json
  error
  created_at
  completed_at
```

## Implementation Prompt

```txt
You are implementing Cloud MCP for Corpus.

Goal:
Make Corpus a cloud-hosted MCP server for Roblox Studio. Remove active reliance on the local Node bridge, session codes, official local StudioMCP, and path-based plugin protocol. The only local component should be the Corpus Roblox Studio plugin, which authenticates with a Studio token and long-polls the cloud for tool calls.

Required changes:
1. Replace all active Studio relay calls from path-based `{ path, body }` to tool-name `{ tool, arguments }`.
2. In `server/agent/tools.ts`, rename `endpoint` to `mcpTool` and map tools to names like `read_script`, `write_script`, `create_instance`.
3. Remove `OfficialMcpTransport`, `CompositeStudioTransport`, `mcp-stdio.ts`, and `CORPUS_STUDIO_TRANSPORT` from the active server flow.
4. Implement `PluginRelayTransport` as the only Studio transport.
5. Replace `/corpus/token/poll` and `/corpus/token/respond` with cloud endpoints:
   - `GET /studio/poll`
   - `POST /studio/respond`
6. Poll must authenticate with `Authorization: Bearer <studio_token>` or `X-Corpus-Token`.
7. Poll must return `{ id, tool, arguments }` or `{ id: null }`.
8. Respond must accept `{ id, result, isError, error }`.
9. Add `server/agent/mcp-server.ts` implementing MCP JSON-RPC:
   - `initialize`
   - `tools/list`
   - `tools/call`
10. Add `/mcp`, `/mcp/info` routes.
11. MCP `tools/call` must authenticate the user, find their active Studio connection, enqueue the tool call, wait for plugin response, and return MCP content.
12. Keep approval policy for risky tools before enqueueing mutations.
13. Add plugin protocol version/capability checks.
14. Remove or ignore legacy session-code routes and `public/studio-plugin/corpus-bridge.server.lua`.
15. Add tests for:
   - token auth
   - poll/respond lifecycle
   - MCP tools/list
   - MCP tools/call success
   - Studio disconnected error
   - operation timeout

Do not implement unrelated UI redesigns. Do not keep parallel local MCP paths. The result should be cloud MCP only.
```

