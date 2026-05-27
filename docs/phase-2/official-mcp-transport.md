# Official Roblox Studio MCP Transport

Date: 2026-05-27

## Summary

The Stud agent now talks to Roblox Studio through one of two transports,
selected at bridge startup:

| Transport | Source | When used |
| --- | --- | --- |
| `official_mcp` | Roblox's built-in `StudioMCP --stdio` server | Preferred when the binary is present and `STUD_STUDIO_TRANSPORT` is `mcp` or unset/`auto` |
| `plugin_fallback` | The existing `studio-plugin/stud-bridge.server.lua` polling plugin | Used when MCP is unavailable, when an operation is not yet mapped to an MCP call, or when `STUD_STUDIO_TRANSPORT=plugin` is set |

The policy gateway (`mcp__roblox_studio__*` tool names, permission engine,
audit trail, approved scopes, conflict detection, mutation/diff events,
operation/idempotency IDs) is unchanged. Only the bytes underneath shift
between MCP stdio and the polling relay.

## Files

| File | Role |
| --- | --- |
| `server/agent/mcp-stdio.ts` | JSON-RPC stdio client for the official `StudioMCP --stdio` server: spawn, `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, timeouts, cancellation via `AbortSignal`, malformed-line reporting |
| `server/agent/studio-transport.ts` | `PluginRelayTransport`, `OfficialMcpTransport`, `CompositeStudioTransport`, and the Luau fenced-JSON wrappers used to satisfy Stud relay paths via MCP `run_code` |
| `server/index.js` | Resolves the StudioMCP binary, constructs the composite transport, exposes `/stud/studio/status` and richer session status with the active transport |
| `src/lib/roblox/client.ts` | New `getStudioStatus()` and `StudioTransportStatus` type |
| `src/components/ConnectionStatus.tsx` | Shows an `official MCP` or `plugin fallback` badge alongside the connected dot |

## Environment

| Variable | Effect |
| --- | --- |
| `STUD_STUDIO_TRANSPORT=mcp` | Strict: always go through StudioMCP. If MCP throws on a supported path the error is surfaced (no silent plugin fallback). |
| `STUD_STUDIO_TRANSPORT=plugin` | Force plugin polling. The StudioMCP process is never spawned. |
| `STUD_STUDIO_TRANSPORT=auto` (default, also any unset value) | Try MCP first per supported path; fall back to the plugin on any MCP error or unsupported path. |
| `STUD_STUDIO_MCP_BINARY` | Override the StudioMCP binary path. Defaults to `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` on macOS. |
| `STUD_STUDIO_MCP_ARGS` | Args passed to the binary. Defaults to `--stdio`. |
| `STUD_STUDIO_MCP_DEBUG=1` | Forward StudioMCP `stderr` to the bridge process stderr. |

## Local Setup

1. **Enable the built-in MCP server in Roblox Studio**
   1. Open Roblox Studio.
   2. `File → Beta Features` and enable **Model Context Protocol Studio Server** (also referred to as **Studio MCP Server**).
   3. Restart Studio. Open the place you want Stud to operate on.
   4. Verify the bundled binary exists:

      ```sh
      ls /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
      ```

      If you installed Studio in a non-default location, set `STUD_STUDIO_MCP_BINARY` to its absolute path.

2. **Start the Stud bridge**

   ```sh
   # default = auto: prefer MCP, fall back to plugin
   npm run dev

   # explicit official-only mode (recommended once Studio MCP is enabled)
   STUD_STUDIO_TRANSPORT=mcp npm run dev

   # force legacy plugin polling (compat mode)
   STUD_STUDIO_TRANSPORT=plugin npm run dev
   ```

   Within a few seconds of startup you should see:

   ```
   [studio-mcp] connected via /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP; tools=run_code,insert_model,get_console_output,start_stop_play,run_script_in_play_mode,get_studio_mode
   ```

3. **Verify the active transport**

   - HTTP: `curl http://127.0.0.1:3001/stud/studio/status` returns

     ```json
     {
       "connected": true,
       "pluginConnected": false,
       "mcpConnected": true,
       "configuredTransport": "auto",
       "preferredTransport": "official_mcp",
       "effectiveTransport": "official_mcp",
       "lastUsedTransport": "official_mcp",
       "mcpServer": { "name": "Roblox_Studio", "version": "..." },
       "mcpTools": ["run_code", "insert_model", "get_console_output", "start_stop_play", "run_script_in_play_mode", "get_studio_mode"]
     }
     ```

   - Web UI: the header connection badge shows the `official MCP` chip next
     to the green Connected dot when the agent is routing through StudioMCP,
     and `plugin fallback` when it is using the polling plugin.

4. **First end-to-end check**

   With Studio open and `STUD_STUDIO_TRANSPORT=mcp` set, ask the chat:

   > List the children of `game.Workspace`.

   That triggers `mcp__roblox_studio__list_children`, which the
   `OfficialMcpTransport` serves by sending an `run_code` MCP call wrapped
   with a Luau snippet that prints fenced JSON (`<<STUD_MCP_JSON_BEGIN>> …
   <<STUD_MCP_JSON_END>>`). The agent then walks the structured result.

   For an approved mutation, ask:

   > Create a Folder named `StudTest` under `game.Workspace`.

   That maps to `mcp__roblox_studio__create_instance`, which is policy
   `low_mutation` → user approval card → MCP `run_code(Instance.new …)` →
   `mutation_result` event in the UI.

## Operations Routing

| Stud tool | MCP route | Plugin route |
| --- | --- | --- |
| `mcp__roblox_studio__execute_luau` | `run_code` (direct) | `/code/run` |
| `mcp__roblox_studio__read_script` | `run_code` wrapper around `ScriptEditorService:GetEditorSource` | `/script/get` |
| `mcp__roblox_studio__write_script` | `run_code` wrapper around `ScriptEditorService:UpdateSourceAsync` | `/script/set` |
| `mcp__roblox_studio__edit_script` | MCP read + `gsub` + MCP write | `/script/edit` |
| `mcp__roblox_studio__list_children` | `run_code` wrapper enumerating `GetChildren` / `GetDescendants` | `/instance/children` |
| `mcp__roblox_studio__create_instance` | `run_code` wrapper with `Instance.new` | `/instance/create` |
| `mcp__roblox_studio__delete_instance` | `run_code` wrapper with `instance:Destroy()` | `/instance/delete` |
| `mcp__roblox_studio__set_property` | `run_code` wrapper that assigns the property | `/instance/set` |
| `mcp__roblox_studio__get_selection` | `run_code` wrapper around `Selection:Get()` | `/selection/get` |
| `mcp__roblox_studio__start_playtest` / `stop_playtest` | `start_stop_play` with `mode=start_play` / `stop` | `/playtest/start`, `/playtest/stop` |
| `mcp__roblox_studio__get_logs` / `get_diagnostics` | `get_console_output` (parsed and filtered) | `/playtest/logs`, `/playtest/diagnostics` |

### Still plugin-only (no official MCP equivalent)

The official MCP surface from `studio-rust-mcp-server` only exposes
`run_code`, `insert_model`, `get_console_output`, `start_stop_play`,
`run_script_in_play_mode`, and `get_studio_mode`. The following Stud tools
still require the polling plugin:

- `mcp__roblox_studio__get_properties` (typed property snapshot)
- `mcp__roblox_studio__clone_instance`, `move_instance`, `search_instances`
- `mcp__roblox_studio__bulk_create`, `bulk_delete`, `bulk_set_property`
- `mcp__roblox_studio__insert_asset` (asset-ID-based Toolbox insertion with
  script-strip preview; MCP's `insert_model` is query-based and does not
  return the inspection metadata the policy engine needs)
- `mcp__roblox_studio__get_live_context`
- Toolbox asset inspection (`/asset/inspect`)

When `STUD_STUDIO_TRANSPORT=auto` (the default) the `CompositeStudioTransport`
delegates these to the plugin automatically. When
`STUD_STUDIO_TRANSPORT=mcp` it surfaces the error rather than silently
falling back, so you can see which operations still need the plugin.

## Safety Properties Preserved

- The browser cannot reach MCP directly; mutating bridge paths still require
  the `X-Stud-Agent-Relay` token enforced in `server/index.js`.
- Policy decisions (`server/agent/policy.ts`) and approval flows are evaluated
  *before* `OfficialMcpTransport.request()` ever runs, so MCP cannot be used
  to bypass approval cards or plan mode.
- `ScriptRevisionTracker` SHA-256 conflict checks (`server/agent/conflict.ts`)
  apply equally to both transports, because they happen inside the gateway
  tools, not inside the transport.
- Audit events (`tool_requested`, `policy_decision`, `tool_outcome`) are emitted
  identically; the only new information is the active transport reported by
  `/stud/studio/status`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Bridge logs `connect failed: spawn ... ENOENT` | `StudioMCP` binary not at the resolved path; set `STUD_STUDIO_MCP_BINARY` |
| `connect failed: ... timed out` | Studio MCP beta feature not enabled; enable it under `File → Beta Features` and restart Studio |
| `/stud/studio/status` shows `mcpConnected: false` even though Studio is open | The MCP beta server didn't bind; close Studio, ensure no other `StudioMCP` is running, restart, then `STUD_STUDIO_MCP_DEBUG=1 npm run dev:bridge` |
| `effectiveTransport` flips to `plugin_fallback` mid-session | The MCP child process exited (look for `[studio-mcp] process exited code=` in bridge stdout); the plugin polling loop continues to handle traffic until you restart the bridge |
