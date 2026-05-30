
⏺ Good. I have everything I need. Here's the full plan.

  ---
  MCP on Cloud — Full Implementation Plan

  ---
  The Architecture You're Building

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

  Three audiences talk to your cloud MCP server:
  1. Your own AI agent (internal, same process)
  2. Your web app (via SSE stream)
  3. External MCP clients like Cursor, Claude Desktop (via MCP HTTP transport)

  ---
  What Changes vs What Stays

  Stays exactly the same:
  - server/agent/runtime.ts — AI agent loop
  - server/agent/scheduler.ts — parallel/serial batching
  - server/agent/plan.ts — plan/approve flow
  - server/agent/policy.ts — permission gates
  - server/agent/store.ts — conversation persistence
  - server/agent/drivers.ts — model drivers
  - All the Zod schemas in server/agent/tools.ts
  - The plugin's actual Lua handlers (the business logic)

  Changes:
  - studio-plugin/stud-bridge.server.lua — ONE update, then frozen forever
  - server/index.js — add MCP server endpoint
  - server/agent/studio-transport.ts — update plugin relay transport format
  - New file: server/agent/mcp-server.ts — the MCP protocol layer

  ---
  Phase 0 — Auth (do this first, everything depends on it)
  
  The problem with current auth

  Right now sessions are 6-char codes (SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/). That's fine for local dev. In production with real users, you need
  proper tokens.

  What to build

  Step 0.1 — User account tokens

  When a user signs up on stud.com, generate a studioToken — a cryptographically random 32-byte string stored server-side tied to their account.

  User signs up → server generates: studioToken = randomBytes(32).toString('base64url')
  Server stores: { userId, studioToken, createdAt }
  Web app shows: token as a copyable string + QR code

  Step 0.2 — Plugin uses the token

  Plugin stores the token via plugin:SetSetting("StudioToken", token). Every poll request includes it:

  -- In the plugin's poll request:
  Headers = {
    ["X-Stud-Token"] = plugin:GetSetting("StudioToken"),
    ["Content-Type"] = "application/json"
  }

  Server validates the token, looks up which user it belongs to, routes tool calls to the right session.

  Step 0.3 — Session pairing (simplified)

  The 6-char session code becomes optional. The token IS the identity. No more manual copy-paste. Plugin connects → server knows who it is → web app sees
  "Studio connected" automatically.

  The flow becomes:
  User opens Studio → plugin has their token → connects automatically
  User opens stud.com → logs in → sees "Studio: Connected"
  Done. No session code needed.

  ---
  Phase 1 — Plugin Update (one time, then freeze)
  
  This is the one Lua change you'll ever make. After this, the plugin never changes.

  What changes in stud-bridge.server.lua

  1. Hardcode production URL
  -- Remove:
  local DEFAULT_BRIDGE = "http://127.0.0.1:3001"

  -- Add:
  local DEFAULT_BRIDGE = "https://your-production-server.com"

  2. Add token to every poll request
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

  3. Update poll response format to handle MCP tool calls

  Current format the plugin reads:
  -- Old: { id = "req_1", request = { path = "/script/set", body = "..." } }

  New format (MCP-flavored):
  -- New: { id = "req_1", tool = "write_script", arguments = { path = "...", source = "..." } }

  The handler dispatch changes from:
  -- Old
  local handler = handlers[request.path]

  To:
  -- New
  local handler = handlers[response.tool]

  4. Rename handler keys to match MCP tool names

  -- Old keys:          New keys:
  handlers["/script/get"]      → handlers["read_script"]
  handlers["/script/set"]      → handlers["write_script"]
  handlers["/script/edit"]     → handlers["edit_script"]
  handlers["/instance/children"] → handlers["list_children"]
  handlers["/instance/properties"] → handlers["get_properties"]
  handlers["/instance/set"]    → handlers["set_property"]
  handlers["/instance/create"] → handlers["create_instance"]
  handlers["/instance/delete"] → handlers["delete_instance"]
  handlers["/instance/clone"]  → handlers["clone_instance"]
  handlers["/instance/move"]   → handlers["move_instance"]
  handlers["/instance/search"] → handlers["search_instances"]
  handlers["/selection/get"]   → handlers["get_selection"]
  handlers["/code/run"]        → handlers["execute_luau"]
  handlers["/playtest/start"]  → handlers["start_playtest"]
  handlers["/playtest/stop"]   → handlers["stop_playtest"]
  handlers["/playtest/logs"]   → handlers["get_logs"]
  handlers["/playtest/diagnostics"] → handlers["get_diagnostics"]
  handlers["/ping"]            → handlers["ping"]

  The handler BODIES don't change at all. Just the keys.

  5. Update respond format

  -- Old respond body:
  { id = requestId, response = { status = 200, body = resultJson } }

  -- New respond body:
  { id = requestId, result = resultJson, isError = false }
  -- or on error:
  { id = requestId, result = nil, isError = true, error = errorMessage }

  6. Add a simple onboarding UI

  Replace the current "enter bridge URL + session code" UI with:
  [ Enter your Stud token: ________________ ] [Connect]

  Token comes from stud.com account page. User pastes it once. Plugin saves it forever.

  This is the last plugin change. Submit to Creator Store. Done.

  ---
  Phase 2 — Cloud MCP Server Layer

  New file: server/agent/mcp-server.ts

  What it does

  Sits between the plugin relay queue and everything that wants to call Studio tools. Speaks proper MCP JSON-RPC 2.0.

  The pending queue — unchanged concept, new format

  The session.pending Map in server/index.js currently stores {path, body}. Update it to store MCP tool calls:

  // server/index.js — update PendingRequest type
  type PendingRequest = {
    tool: string;                        // MCP tool name e.g. "write_script"  
    arguments: Record<string, unknown>;  // tool arguments
    operationId?: string;
    resolve: (result: JsonValue) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    createdAt: number;
  }

  The poll response the plugin gets:
  {
    "id": "req_1_1748600000",
    "tool": "write_script",
    "arguments": { "path": "game.Workspace.MyScript", "source": "print('hello')" }
  }
  
  The respond POST the plugin sends back:
  {
    "id": "req_1_1748600000",
    "result": { "path": "game.Workspace.MyScript", "undoWaypoint": "..." },
    "isError": false
  } 

  The MCP server endpoint

  Add to server/index.js:

  GET  /mcp                → SSE stream (MCP server-to-client notifications)
  POST /mcp                → MCP client sends requests here (tools/list, tools/call)

  This is the standard MCP HTTP+SSE transport. Any external MCP client (Cursor, Claude Desktop) can connect here.

  Inside server/agent/mcp-server.ts:

  // MCP tools list — auto-generated from your existing tool definitions in tools.ts
  export function buildMcpToolsList(registry: AgentToolRegistry) {
    return registry.list().map(tool => ({
      name: tool.name.replace("mcp__roblox_studio__", ""),  // strip prefix
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    }));
  }

  // When MCP client calls tools/call:
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

  The relay function — updated signature

  studio-transport.ts's PluginRelayTransport currently sends {path, body}. Update it to send {tool, arguments}:

  // server/agent/studio-transport.ts
  export class PluginRelayTransport {
    async request(sessionId, tool, args, signal, operationId) {
      // Now sends tool name + args directly instead of {path, body}
      return this.relay(sessionId, tool, args, signal, operationId);
    }
  }

  And relayStudioRequest in server/index.js queues {tool, arguments} in session.pending.

  ---
  Phase 3 — Wire the AI Agent to Use MCP Tool Names
  
  Current tool names in tools.ts

  mcp__roblox_studio__write_script
  mcp__roblox_studio__create_instance
  mcp__roblox_studio__execute_luau
  ... etc

  These map to endpoints like /script/set, /instance/create. Update studioTools array in tools.ts to use MCP tool names as the routing key instead of path
  strings:

  // Old:
  { name: "mcp__roblox_studio__write_script", endpoint: "/script/set", ... }

  // New:
  { name: "mcp__roblox_studio__write_script", mcpTool: "write_script", ... }

  The tool's execute() function calls the relay with "write_script" instead of "/script/set". The plugin receives "write_script" and dispatches to
  handlers["write_script"]. Done.

  ---
  Phase 4 — External MCP Client Support

  Once Phase 2 is done, any MCP client can connect to your server. Here's what users of Cursor or Claude Desktop would add to their config:

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

  They connect → your server validates their token → finds their Studio session → all MCP tool calls route to their Studio via the plugin.

  This gives you a second distribution channel — Roblox devs using Cursor or Claude Desktop can use Stud without your web app at all. You become an MCP
  server people add to their existing AI tools.

  ---
  Implementation Order

  Week 1:  Phase 0  — Auth system (tokens, user accounts)
  Week 2:  Phase 1  — Update plugin, submit to Creator Store
  Week 3:  Phase 2  — MCP server layer on cloud
  Week 4:  Phase 3  — Wire agent to new tool routing
  Week 5:  Phase 4  — External MCP client support + docs
  Week 6:  Deploy + monitor

  ---
  Files Changed Summary

  ┌──────────────────────────────────────┬─────────────────────────────────────────────────────────────────┬────────────────┐
  │                 File                 │                             Change                              │ Lines affected │
  ├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┼────────────────┤
  │ studio-plugin/stud-bridge.server.lua │ Token auth, new poll/respond format, handler key rename         │ ~50 lines      │
  ├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┼────────────────┤
  │ server/index.js                      │ Updated pending queue type, add /mcp endpoint, token validation │ ~100 lines     │
  ├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┼────────────────┤
  │ server/agent/studio-transport.ts     │ {path,body} → {tool,arguments} in relay                         │ ~30 lines      │
  ├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┼────────────────┤
  │ server/agent/tools.ts                │ endpoint → mcpTool in studioTools array                         │ ~20 lines      │
  ├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┼────────────────┤
  │ server/agent/mcp-server.ts           │ New file — MCP protocol handler                                 │ ~200 lines     │
  └──────────────────────────────────────┴─────────────────────────────────────────────────────────────────┴────────────────┘

  Everything else — runtime, scheduler, plan, policy, store, drivers — zero changes.

  ---
  The question you need to answer before starting: "Where does user account management live?" Right now there are no user accounts — the 6-char session code
   IS the identity. You need to decide: build auth yourself (Lucia, Auth.js), use a service (Clerk, Supabase Auth, Auth0), or skip auth for now and use API
  keys manually issued to beta users. This decision gates everything in Phase 0.