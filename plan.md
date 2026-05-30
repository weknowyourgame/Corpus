# MCP on Cloud — Full Implementation Plan

## The Architecture We're Building

```
CLOUD SERVER                                    USER'S MACHINE
┌─────────────────────────────────────┐         ┌─────────────────────────────┐
│                                     │         │                             │
│  Web App (React)                    │         │  Roblox Studio              │
│  ↕ SSE                              │         │       ↑                     │
│  AI Agent Runtime                   │         │  Stud Plugin (Creator Store)│
│  ↕ internal                         │  HTTPS  │       ↑                     │
│  MCP Server Layer  ◄────────────────┼─────────┼── polls every 100ms        │
│  ↕ internal                         │         │  responds with results      │
│  Plugin Relay Queue                 │         │                             │
│  (poll/respond pending Map)         │         └─────────────────────────────┘
│                                     │
│  ALSO: External MCP clients         │
│  Cursor / Claude Desktop ───────────┤
│  connect here via HTTP+SSE          │
└─────────────────────────────────────┘
```

Three audiences talk to the cloud MCP server:

1. The internal AI agent (same process)
2. The web app (via SSE stream)
3. External MCP clients — Cursor, Claude Desktop (via MCP HTTP transport)

---

## What Changes vs What Stays

### Stays exactly the same

- `server/agent/runtime.ts` — AI agent loop
- `server/agent/scheduler.ts` — parallel/serial batching
- `server/agent/plan.ts` — plan/approve flow
- `server/agent/policy.ts` — permission gates
- `server/agent/store.ts` — conversation persistence
- `server/agent/drivers.ts` — model drivers
- All Zod schemas in `server/agent/tools.ts`
- The plugin's actual Lua handler bodies (the business logic)

### Changes

- `studio-plugin/stud-bridge.server.lua` — ONE update, then frozen forever
- `server/index.js` — add MCP server endpoint, token validation
- `server/agent/studio-transport.ts` — update plugin relay transport format
- `server/agent/tools.ts` — `endpoint` field → `mcpTool` field
- **New file:** `server/agent/mcp-server.ts` — the MCP protocol layer

---

## Implementation Order


| Week | Phase   | Description                            |
| ---- | ------- | -------------------------------------- |
| 1    | Phase 0 | Auth system — tokens, user accounts    |
| 2    | Phase 1 | Plugin update, submit to Creator Store |
| 3    | Phase 2 | Cloud MCP server layer                 |
| 4    | Phase 3 | Wire AI agent to new tool routing      |
| 5    | Phase 4 | External MCP client support + docs     |
| 6    | —       | Deploy + monitor                       |


---

## Phase 0 — Auth

### The Problem with Current Auth

Sessions are 6-char codes (`SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/`). Fine for local dev. In production with real users you need proper tokens tied to accounts.

### Step 0.1 — User Account Tokens

When a user signs up on stud.com, generate a `studioToken`:

```
User signs up → server generates: studioToken = randomBytes(32).toString('base64url')
Server stores: { userId, studioToken, createdAt }
Web app shows: token as copyable string + QR code
```

### Step 0.2 — Plugin Uses the Token

Plugin stores the token via `plugin:SetSetting("StudioToken", token)`. Every poll request sends it:

```lua
Headers = {
  ["X-Stud-Token"] = plugin:GetSetting("StudioToken"),
  ["Content-Type"] = "application/json"
}
```

Server validates the token, looks up which user it belongs to, routes tool calls to the right session.

### Step 0.3 — Session Pairing Simplified

The 6-char session code becomes unnecessary. The token IS the identity. Plugin connects → server knows who it is → web app sees "Studio connected" automatically.

```
User opens Studio → plugin has their token → connects automatically
User opens stud.com → logs in → sees "Studio: Connected"
Done. No session code needed.
```

---

### Phase 0 Agent Prompt

```
You are implementing auth for "Stud" — an AI coding agent for Roblox Studio.

CODEBASE CONTEXT:
- Server: server/index.js (Express/Bun, port 3001)
- Agent routes: server/agent/routes.ts — createAgentRouter()
- Current auth: 6-char session codes (SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/)
- Current conversation creation: POST /agent/conversations with { studioSessionId }
  → returns { conversation, accessToken } where accessToken = randomBytes(32).toString('base64url')
- Current token validation: timingSafeEqual on SHA-256 hash in server/agent/routes.ts:34-41
- No user account system exists yet. The session code IS the identity.

WHAT TO BUILD:
1. A studioToken system that replaces session codes as the pairing mechanism.
   - When a user account is created, generate: randomBytes(32).toString('base64url')
   - Store it server-side tied to userId: { userId, studioToken, hashedToken, createdAt }
   - The plugin will send this token in X-Stud-Token header on every poll request
   - Server validates token → looks up userId → routes to their session

2. Update server/index.js:
   - Add token validation middleware for /stud/* routes
   - Replace session code lookup with token-based session lookup
   - getSession() should accept either token (new) or sessionId (legacy fallback)
   - Add POST /auth/tokens endpoint: validates user credentials → returns studioToken

3. Update server/agent/routes.ts:
   - POST /agent/conversations: accept optional studioToken instead of requiring studioSessionId
   - Token lookup replaces the 6-char session code

4. Keep full backwards compatibility:
   - Old 6-char session codes still work (legacy support for existing users)
   - New token path is additive, not a replacement yet

CONSTRAINTS:
- No external auth service — build it in-process for now
- Token must be validated with timingSafeEqual (timing-safe comparison), same pattern as existing code in routes.ts:38-40
- Store tokens hashed (SHA-256), never plaintext — same pattern as accessTokenHash in existing code
- Do NOT touch: runtime.ts, scheduler.ts, plan.ts, policy.ts, store.ts, drivers.ts

OUTPUT: Modified server/index.js and server/agent/routes.ts. Show me the diff.
```

---

## Phase 1 — Plugin Update (One Time, Then Frozen Forever)

This is the last Lua change ever made to the plugin. After submission to Creator Store it never changes again.

### Change 1 — Hardcode Production URL

```lua
-- Remove:
local DEFAULT_BRIDGE = "http://127.0.0.1:3001"

-- Add:
local DEFAULT_BRIDGE = "https://your-production-server.com"
```

### Change 2 — Token Auth on Every Poll

```lua
local function pollForWork()
  local token = plugin:GetSetting("StudioToken")
  if not token or token == "" then
    return nil  -- not authenticated, skip poll
  end

  local ok, result = pcall(function()
    return HttpService:RequestAsync({
      Url = getPollUrl(),
      Method = "GET",
      Headers = {
        ["X-Stud-Token"] = token,
        ["Content-Type"] = "application/json"
      }
    })
  end)

  if ok and result.Success then
    return HttpService:JSONDecode(result.Body)
  end
  return nil
end
```

### Change 3 — New Poll Response Format

```lua
-- Old: { id = "req_1", request = { path = "/script/set", body = "..." } }
-- New: { id = "req_1", tool = "write_script", arguments = { path = "...", source = "..." } }

-- Old dispatch:
local handler = handlers[request.path]

-- New dispatch:
local handler = handlers[response.tool]
```

### Change 4 — Rename Handler Keys to MCP Tool Names


| Old key                 | New key            |
| ----------------------- | ------------------ |
| `/script/get`           | `read_script`      |
| `/script/set`           | `write_script`     |
| `/script/edit`          | `edit_script`      |
| `/instance/children`    | `list_children`    |
| `/instance/properties`  | `get_properties`   |
| `/instance/set`         | `set_property`     |
| `/instance/create`      | `create_instance`  |
| `/instance/delete`      | `delete_instance`  |
| `/instance/clone`       | `clone_instance`   |
| `/instance/move`        | `move_instance`    |
| `/instance/search`      | `search_instances` |
| `/selection/get`        | `get_selection`    |
| `/code/run`             | `execute_luau`     |
| `/playtest/start`       | `start_playtest`   |
| `/playtest/stop`        | `stop_playtest`    |
| `/playtest/logs`        | `get_logs`         |
| `/playtest/diagnostics` | `get_diagnostics`  |
| `/ping`                 | `ping`             |


**Handler bodies do not change. Only the keys change.**

### Change 5 — New Respond Format

```lua
-- Old:
{ id = requestId, response = { status = 200, body = resultJson } }

-- New (success):
{ id = requestId, result = resultJson, isError = false }

-- New (error):
{ id = requestId, result = nil, isError = true, error = errorMessage }
```

### Change 6 — Simplified Onboarding UI

Replace "enter bridge URL + session code" with:

```
[ Enter your Stud token: ________________ ] [Connect]
```

Token comes from stud.com account page. User pastes once. Plugin saves forever via `plugin:SetSetting`.

---

### Phase 1 Agent Prompt

```
You are updating the Roblox Studio plugin for "Stud" — an AI coding agent.

CONTEXT:
- Plugin file: studio-plugin/stud-bridge.server.lua (1468 lines)
- This plugin is installed inside Roblox Studio. It polls a server for tool calls
  and executes them using Roblox's Lua APIs.
- This is the LAST time this file will ever be edited. After this change it gets
  submitted to the Roblox Creator Store and frozen permanently.
- Current poll URL: GET /stud/sessions/:id/poll  or  GET /stud/poll (legacy)
- Current respond URL: POST /stud/sessions/:id/respond  or  POST /stud/respond (legacy)
- Current poll response format: { id, request: { path, body } }
- Current respond format: { id, response: { status, body } }
- Handlers are keyed by path strings like handlers["/script/set"]

WHAT TO CHANGE (make all 6 changes in one edit):

1. Add X-Stud-Token header to every HTTP request the plugin makes.
   Token is stored via: plugin:GetSetting("StudioToken")
   If token is empty string or nil, skip polling (user not authenticated).

2. Update the poll response parser:
   - Old: reads response.request.path and response.request.body
   - New: reads response.tool (string) and response.arguments (table)
   - Update handleRequest() at line ~1299 to dispatch via handlers[response.tool]

3. Rename all handler keys (DO NOT change handler bodies, only the table key strings):
   handlers["/script/get"]           → handlers["read_script"]
   handlers["/script/set"]           → handlers["write_script"]
   handlers["/script/edit"]          → handlers["edit_script"]
   handlers["/instance/children"]    → handlers["list_children"]
   handlers["/instance/properties"]  → handlers["get_properties"]
   handlers["/instance/set"]         → handlers["set_property"]
   handlers["/instance/create"]      → handlers["create_instance"]
   handlers["/instance/delete"]      → handlers["delete_instance"]
   handlers["/instance/clone"]       → handlers["clone_instance"]
   handlers["/instance/move"]        → handlers["move_instance"]
   handlers["/instance/search"]      → handlers["search_instances"]
   handlers["/selection/get"]        → handlers["get_selection"]
   handlers["/code/run"]             → handlers["execute_luau"]
   handlers["/playtest/start"]       → handlers["start_playtest"]
   handlers["/playtest/stop"]        → handlers["stop_playtest"]
   handlers["/playtest/logs"]        → handlers["get_logs"]
   handlers["/playtest/diagnostics"] → handlers["get_diagnostics"]
   handlers["/ping"]                 → handlers["ping"]

4. Update respond POST body format:
   Old: { id = id, response = { status = 200, body = HttpService:JSONEncode(result) } }
   New (success): { id = id, result = result, isError = false }
   New (error):   { id = id, result = nil, isError = true, error = tostring(err) }

6. Replace the session code onboarding UI with a token input UI:
   - Remove: bridge URL text field, session code input
   - Add: single text field labelled "Stud Token" with placeholder "Paste token from stud.com"
   - On connect: save token via plugin:SetSetting("StudioToken", tokenValue)
   - Show "Connected" / "Disconnected" status indicator same as before

DO NOT change:
- Any handler body logic (the actual Roblox API calls inside each handler)
- The makeRevision() fingerprint function
- The LogService listener or playtest log buffer
- The ChangeHistoryService waypoint calls
- The polling task.wait(0.1) interval

Output the complete modified file.
```

---

## Phase 2 — Cloud MCP Server Layer

### New File: `server/agent/mcp-server.ts`

Sits between the plugin relay queue and any client that wants to call Studio tools. Speaks proper MCP JSON-RPC 2.0.

### Updated Pending Queue Format

```typescript
// server/index.js — updated PendingRequest shape
type PendingRequest = {
  tool: string;                         // MCP tool name e.g. "write_script"
  arguments: Record<string, unknown>;   // tool arguments
  operationId?: string;
  resolve: (result: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}
```

Poll response the plugin receives:

```json
{
  "id": "req_1_1748600000",
  "tool": "write_script",
  "arguments": { "path": "game.Workspace.MyScript", "source": "print('hello')" }
}
```

Respond POST the plugin sends back:

```json
{
  "id": "req_1_1748600000",
  "result": { "path": "game.Workspace.MyScript", "undoWaypoint": "..." },
  "isError": false
}
```

### New Endpoints in `server/index.js`

```
GET  /mcp    → SSE stream (MCP server-to-client notifications)
POST /mcp    → MCP JSON-RPC requests (tools/list, tools/call)
```

### Core Logic in `server/agent/mcp-server.ts`

```typescript
// Auto-generate MCP tools list from existing tool registry
export function buildMcpToolsList(registry: AgentToolRegistry) {
  return registry.list().map(tool => ({
    name: tool.name.replace("mcp__roblox_studio__", ""),
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  }));
}

// Handle a tools/call from an external MCP client
export async function handleMcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
  relay: StudioRelayFn,
  signal: AbortSignal,
) {
  const operationId = randomUUID();
  return relay(sessionId, toolName, args, signal, operationId);
}
```

### Updated `PluginRelayTransport` in `studio-transport.ts`

```typescript
export class PluginRelayTransport {
  async request(sessionId, tool, args, signal, operationId) {
    // Sends { tool, arguments } instead of old { path, body }
    return this.relay(sessionId, tool, args, signal, operationId);
  }
}
```

---

### Phase 2 Agent Prompt

```
You are adding a proper MCP (Model Context Protocol) server layer to "Stud" —
an AI coding agent for Roblox Studio.

CODEBASE CONTEXT:
- Main server: server/index.js (Express/Bun, 668 lines)
- Tool registry: server/agent/tools.ts — class RobloxStudioMcpGateway, studioTools array
  Each tool has: { name, description, schema (Zod), endpoint, risk, scope }
  Tool names look like: "mcp__roblox_studio__write_script"
- Transport layer: server/agent/studio-transport.ts
  Key class: PluginRelayTransport — calls relay(sessionId, path, body, signal, opId)
  relay() maps to relayStudioRequest() in server/index.js which queues in session.pending
- Current pending queue shape: { request: { path, body }, resolve, reject, timer, createdAt }
- Current poll response to plugin: { id, request: { path, body } }
- Current respond from plugin: { id, response: { status, body } }
- MCP client we already have: server/agent/mcp-stdio.ts (StudioMcpClient)
  This is an MCP CLIENT that talks to Roblox's binary. We are now building an MCP SERVER.
- MCP protocol version: "2024-11-05"
- MCP HTTP transport: GET for SSE stream, POST for JSON-RPC requests

WHAT TO BUILD:

1. New file server/agent/mcp-server.ts:
   - export class McpServer that handles MCP JSON-RPC 2.0 messages
   - Handles methods: initialize, notifications/initialized, tools/list, tools/call
   - initialize: returns { protocolVersion: "2024-11-05", serverInfo: { name: "stud", version: "0.1.0" }, capabilities: { tools: {} } }
   - tools/list: returns all tools from the registry with MCP tool name format
     Strip "mcp__roblox_studio__" prefix from tool names for external clients
   - tools/call: validates tool exists, calls relay with (sessionId, toolName, args, signal, opId)
     Returns MCP result format: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false }
     On error: { content: [{ type: "text", text: errorMessage }], isError: true }
   - export function buildMcpToolsList(registry: AgentToolRegistry): McpToolSchema[]
   - export function createMcpRequestHandler(registry, relay): Express handler

2. Update server/index.js:
   - Add GET /mcp route: SSE stream for MCP server-to-client messages
     Sets Content-Type: text/event-stream, sends keep-alive every 15s
     Authenticates via X-Stud-Token header or Bearer token
   - Add POST /mcp route: receives MCP JSON-RPC, dispatches to McpServer
     Authenticates, finds sessionId from token, calls createMcpRequestHandler
   - Update session.pending Map type: replace { path, body } with { tool, arguments }
   - Update poll route GET /stud/sessions/:id/poll response:
     Old: { id, request: { path, body } }
     New: { id, tool, arguments }
   - Update respond route POST /stud/sessions/:id/respond to accept:
     Old: { id, response: { status, body } }
     New: { id, result, isError, error? }
     On isError=false: resolve(result)
     On isError=true: reject(new Error(error))

3. Update server/agent/studio-transport.ts:
   - PluginRelayTransport.request() signature stays the same externally
   - Internally: relay is called with (sessionId, tool, args, signal, opId)
     where tool is the MCP tool name (e.g. "write_script") not a path
   - Remove MCP_SUPPORTED_PATHS (no longer needed — all paths go through same queue)
   - CompositeStudioTransport simplified: only PluginRelayTransport remains
     (OfficialMcpTransport is for the local binary, not needed in cloud deployment)

CONSTRAINTS:
- MCP JSON-RPC: every request has { jsonrpc: "2.0", id, method, params }
- Every response has { jsonrpc: "2.0", id, result } or { jsonrpc: "2.0", id, error: { code, message } }
- Notifications (no id field) are fire-and-forget, no response needed
- tools/call result MUST have content array, not a bare object
- Do NOT change: runtime.ts, scheduler.ts, plan.ts, policy.ts, store.ts, drivers.ts
- Keep legacy /stud/poll and /stud/respond routes working (for plugin backwards compat during transition)

Output: server/agent/mcp-server.ts (new), diffs for server/index.js and server/agent/studio-transport.ts
```

---

## Phase 3 — Wire AI Agent to MCP Tool Names

### Current State in `tools.ts`

Each tool has an `endpoint` string like `/script/set`. The tool's `execute()` calls the relay with that path string.

### What Changes

```typescript
// Old:
{
  name: "mcp__roblox_studio__write_script",
  endpoint: "/script/set",
  // execute() calls: relay(sessionId, "/script/set", body, signal, opId)
}

// New:
{
  name: "mcp__roblox_studio__write_script",
  mcpTool: "write_script",
  // execute() calls: relay(sessionId, "write_script", args, signal, opId)
}
```

The plugin receives `"write_script"` and dispatches to `handlers["write_script"]`. The path string `/script/set` is retired entirely.

---

### Phase 3 Agent Prompt

```
You are updating the tool routing in "Stud" — an AI coding agent for Roblox Studio.

CODEBASE CONTEXT:
- Tool definitions: server/agent/tools.ts
  Key structure: studioTools array, each entry has { name, description, schema, endpoint, risk, scope }
  The endpoint field is a path string like "/script/set", "/instance/create" etc.
  Each tool's execute() function calls:
    relay(sessionId, this.endpoint, normalizeBody(input), signal, operationId)
  relay is the StudioRelayFn from studio-transport.ts
- After Phase 2, relay() now expects (sessionId, toolName, args, signal, opId)
  where toolName is an MCP tool name string like "write_script" not a path

WHAT TO CHANGE in server/agent/tools.ts:

1. Rename the endpoint field to mcpTool in the studioTools array type definition.

2. For each tool entry, replace the endpoint path with the MCP tool name:
   "/script/get"            → "read_script"
   "/script/set"            → "write_script"
   "/script/edit"           → "edit_script"
   "/instance/children"     → "list_children"
   "/instance/properties"   → "get_properties"
   "/instance/set"          → "set_property"
   "/instance/create"       → "create_instance"
   "/instance/delete"       → "delete_instance"
   "/instance/clone"        → "clone_instance"
   "/instance/move"         → "move_instance"
   "/instance/search"       → "search_instances"
   "/selection/get"         → "get_selection"
   "/code/run"              → "execute_luau"
   "/playtest/start"        → "start_playtest"
   "/playtest/stop"         → "stop_playtest"
   "/playtest/logs"         → "get_logs"
   "/playtest/diagnostics"  → "get_diagnostics"
   "/asset/inspect"         → "inspect_asset"
   "/asset/insert"          → "insert_asset"

3. Update the execute() function in RobloxStudioMcpGateway.get() (the tool builder):
   Old: relay(sessionId, tool.endpoint, normalizeBody(input), signal, operationId)
   New: relay(sessionId, tool.mcpTool, normalizeBody(input), signal, operationId)

4. Update MUTATING_STUDIO_PATHS in server/index.js to use new tool names:
   Old: Set of path strings like "/script/set"
   New: Set of MCP tool names like "write_script"

DO NOT change:
- Tool names (the mcp__roblox_studio__* strings) — AI still uses these
- Zod schemas — input validation unchanged
- Risk levels, scope functions, descriptions
- normalizeBody() function — still normalizes path fields in arguments
- Any file outside tools.ts and server/index.js

Output: diff of server/agent/tools.ts and the MUTATING_STUDIO_PATHS update in server/index.js
```

---

## Phase 4 — External MCP Client Support

### What Users of Cursor / Claude Desktop Add to Their Config

```json
{
  "mcpServers": {
    "stud": {
      "type": "http",
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer <their-stud-token>"
      }
    }
  }
}
```

They connect → server validates token → finds their Studio session → all MCP tool calls route to Studio via the plugin.

### Distribution Benefit

Once this is live, Roblox developers using Cursor or Claude Desktop can use Stud without the web app. Stud becomes an MCP server people add to their existing AI tools — a second distribution channel with zero extra work per user.

---

### Phase 4 Agent Prompt

```
You are adding external MCP client support to "Stud" — an AI coding agent for Roblox Studio.

CONTEXT:
- After Phase 2, the server has GET /mcp (SSE) and POST /mcp (JSON-RPC) endpoints
- After Phase 0, users have studioTokens stored in the database
- External MCP clients (Cursor, Claude Desktop) connect via HTTP+SSE transport
- MCP HTTP transport spec: client GETs SSE endpoint first, then POSTs requests
  Server sends responses via the SSE stream

WHAT TO BUILD:

1. Full MCP HTTP+SSE transport compliance in server/agent/mcp-server.ts:
   - GET /mcp: 
     * Validates Authorization: Bearer <studioToken> header
     * Looks up userId from token
     * Opens SSE stream
     * Stores the SSE stream in a Map keyed by userId so POST handler can write to it
     * Sends MCP endpoint event: data: { type: "endpoint", uri: "/mcp" }
     * Sends keep-alive comments every 15s (": ping")
     * Cleans up on client disconnect
   - POST /mcp:
     * Validates same token
     * Looks up SSE stream for this userId
     * Processes JSON-RPC message
     * Writes response back via SSE stream: data: <json-rpc-response>

2. Session resolution:
   - From studioToken → userId → find the active Studio session for that userId
   - A user may have multiple Studio sessions (multiple place files open)
   - Default: use the most recently polled session
   - If no active session: return MCP error { code: -32001, message: "No Studio session connected" }

3. Rate limiting for external clients:
   - External MCP clients get same rate limits as internal agent (use existing RateLimiter in rate-limit.ts)
   - Key by userId, not sessionId

4. Tool filtering for external clients:
   - External clients should NOT see internal tools: submit_plan, ask_user_question, subagent
   - Only expose the mcp__roblox_studio__* tools (the Studio ones)
   - Filter in buildMcpToolsList() based on tool.transport !== "server"

5. Docs endpoint:
   - GET /mcp/info → returns { name: "Stud", description: "AI coding agent for Roblox Studio", tools: [...toolNames] }
   - No auth required — for discoverability

6. Add to README / docs the exact JSON config snippet for Cursor and Claude Desktop.

CONSTRAINTS:
- SSE responses must be newline-delimited: each event is "data: <json>\n\n"
- MCP protocol version: "2024-11-05"
- Do NOT expose the /agent/* routes to external clients — those are web app only
- External clients cannot trigger approval flows — if a tool requires approval,
  return an error: "This tool requires user approval. Use the Stud web app."

Output: updated server/agent/mcp-server.ts and the /mcp/info route addition to server/index.js
```

---

## Files Changed Summary


| File                                   | Change                                                        | Lines |
| -------------------------------------- | ------------------------------------------------------------- | ----- |
| `studio-plugin/stud-bridge.server.lua` | Token auth, new poll/respond format, handler key rename       | ~50   |
| `server/index.js`                      | Updated pending queue type, `/mcp` endpoint, token validation | ~100  |
| `server/agent/studio-transport.ts`     | `{path,body}` → `{tool,arguments}` in relay                   | ~30   |
| `server/agent/tools.ts`                | `endpoint` → `mcpTool` in studioTools array                   | ~20   |
| `server/agent/mcp-server.ts`           | **New file** — MCP protocol handler                           | ~200  |


Everything else — `runtime.ts`, `scheduler.ts`, `plan.ts`, `policy.ts`, `store.ts`, `drivers.ts` — zero changes.

---

## Decision Required Before Starting Phase 0

**Where does user account management live?**

Right now there are no user accounts — the 6-char session code IS the identity. Options:


| Option                                      | Effort  | Best for                 |
| ------------------------------------------- | ------- | ------------------------ |
| Build in-process (simple token table in DB) | Low     | Beta / early users       |
| Clerk / Auth0 / Supabase Auth               | Medium  | Production, social login |
| API keys issued manually                    | Minimal | Private beta only        |


This decision gates everything in Phase 0. Pick before writing any code.