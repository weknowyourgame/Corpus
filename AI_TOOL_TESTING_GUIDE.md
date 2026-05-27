# Stud AI Tool Calling Flow - Complete Testing Guide

This guide shows you how to test the complete AI → Agent → Bridge → Studio plugin tool calling flow. You'll see exactly what requests are made and what responses you should expect.

## Overview: The AI Tool Calling Flow

```
AI (Web App) 
    ↓ (POST /agent/conversations/:id/runs)
Agent Runtime 
    ↓ (Calls tools via RobloxStudioMcpGateway)
Studio Tool Gateway 
    ↓ (POST /stud/sessions/:id/request → waits)
Bridge Server 
    ↓ (Studio Plugin polls: GET /stud/sessions/:id/poll)
Studio Plugin (Lua)
    ↓ (Executes Roblox API call)
    ↓ (POST /stud/sessions/:id/respond with result)
Bridge Server 
    ↓ (Returns result to Agent)
Agent Runtime 
    ↓ (Returns result to AI/Web App)
```

## Prerequisites

1. **Bridge server running**: `npm run dev:bridge` (port 3001)
2. **Studio plugin running in Roblox Studio** (or simulate it with curl as shown below)
3. **API keys configured** in `.env` for at least one AI provider

## Step 1: Set Up Environment Variables

Create a `.env` file in the stud directory:
```
PORT=3001
STUD_INTERNAL_RELAY_TOKEN=test-token-123
# Add at least one AI provider key:
ANTHROPIC_API_KEY=your-anthropic-key-here
# OR
OPENROUTER_API_KEY=your-openrouter-key-here
# OR  
STUD_CODEX_ACCESS_TOKEN=your-codex-token-here
```

## Step 2: Test the Complete Flow with Real AI

Let's test asking the AI to get the current selection in Studio:

### 2.1 Create a Conversation (Web App → Agent)
```bash
curl -X POST http://localhost:3001/agent/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{"studioSessionId": "TEST123"}'
```

**Response:**
```json
{
  "conversation": {
    "id": "conv_abc123",
    "studioSessionId": "TEST123",
    "createdAt": 1716745200000,
    "updatedAt": 1716745200000
  },
  "accessToken": "your-access-token-here"
}
```
Save the `conversation.id` and `accessToken` for later use.

### 2.2 Start an Agent Run (AI Asking a Question)
```bash
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "What is currently selected in Studio?",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "mode": "execute"
  }'
```

**Response:**
```json
{
  "id": "run_def456",
  "conversationId": "conv_abc123",
  "status": "in_progress",
  "createdAt": 1716745200000,
  "updatedAt": 1716745200000
}
```
Save the `run.id` for later use.

### 2.3 Watch for Tool Calls (Events Stream)
In another terminal, subscribe to events to see what tools the AI is calling:
```bash
curl -N http://localhost:3001/agent/conversations/conv_abc123/events \
  -H "Authorization: Bearer test-token-123" \
  -H "Last-Event-ID: 0"
```

You'll see events like:
```
data: {"sequence":1,"type":"run_started","runId":"run_def456"}
data: {"sequence":2,"type":"tool_call","toolCallId":"call_abc","toolName":"mcp__roblox_studio__get_selection","toolInput":{}}
data: {"sequence":3,"type":"tool_result","toolCallId":"call_abc","toolName":"mcp__roblox_studio__get_selection","result":[{"name":"Part","class":"Part"}]}
data: {"sequence":4,"type":"run_completed","runId":"run_def456"}
```

### 2.4 See What the Bridge Actually Received
While the event stream is running, check what the bridge received:
```bash
# In another terminal - check pending request
curl -s http://localhost:3001/stud/sessions/TEST123/poll
# Should show: {"id":"req_...","request":{"path":"/selection/get","body":null}}

# Respond to simulate Studio
curl -X POST http://localhost:3001/stud/sessions/TEST123/respond \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: test-token-123" \
  -d '{"id":"req_...","response":{"status":200,"body":"[{\"name\":\"SelectedPart\",\"class\":\"Part\"}]"}}'
```

## Step 3: Test Specific Tool Flows Manually

You can bypass the AI and directly test how each tool works by calling the agent endpoints that mimic what the AI would do.

### 3.1 Test `roblox_get_selection` Tool
```bash
# 1. Start a run that will call the get_selection tool
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "Get current selection",
    "provider": "anthropic", 
    "model": "claude-3-5-sonnet-20241022"
  }'

# 2. Watch events to see the tool call
# 3. Respond to the bridge request when it appears in poll
```

### 3.2 Test `roblox_get_properties` Tool
```bash
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "What properties does Workspace have?",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```
This will call `/instance/properties` with path `game.Workspace`

### 3.3 Test `roblox_set_property` Tool (Mutation)
```bash
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "Set the Name property of Workspace to \"MyGame\"",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```
Note: This requires the `X-Stud-Agent-Relay` header when responding because it's a mutating operation.

### 3.4 Test `roblox_create` Tool
```bash
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "Create a Part in Workspace",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```
This calls `/instance/create` with `{className: "Part", parent: "game.Workspace"}`

### 3.5 Test `roblox_run_code` Tool
```bash
curl -X POST http://localhost:3001/agent/conversations/conv_abc123/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "Print hello world in the output",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "body": { "code": "print('Hello World')" }
  }'
```
This calls `/code/run` with `{code: "print('Hello World')"}` and requires the relay header.

## Step 4: Test Without AI (Direct Tool Execution)

If you don't have API keys or want to test the tool execution directly:

### 4.1 Use the Agent's Tool Execution Endpoint (Not Exposed Publicly)
The agent runtime doesn't expose a direct "execute tool" endpoint, but you can see what happens by:

1. Starting a run with a simple message
2. Watching the events to see what tool gets called
3. Manually responding to simulate Studio

### 4.2 Example: Testing Get Selection Without AI
```bash
# Terminal 1: Check if any requests are pending (should be none initially)
curl -s http://localhost:3001/stud/sessions/TEST123/poll

# Terminal 2: Manually trigger what the agent would do
# (This simulates the agent calling the get_selection tool)
curl -X POST http://localhost:3001/stud/sessions/TEST123/request \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: test-token-123" \
  -d '{"path":"/selection/get","body":null}'
# This will hang waiting for Studio response

# Terminal 3: Respond as Studio would
curl -s http://localhost:3001/stud/sessions/TEST123/poll
# Get the ID from above, then:
curl -X POST http://localhost:3001/stud/sessions/TEST123/respond \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: test-token-123" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"[{\"name\":\"TestPart\",\"class\":\"Part\"}]"}}'

# Back in Terminal 2: You'll see the result
```

## Step 5: Understanding the Tool Names and Endpoints

Here's what each Roblox tool maps to:

| Tool Name (in AI) | Bridge Endpoint | Description |
|-------------------|-----------------|-------------|
| `mcp__roblox_studio__get_selection` | `/selection/get` | Get selected instances |
| `mcp__roblox_studio__get_properties` | `/instance/properties` | Get properties for instance |
| `mcp__roblox_studio__set_property` | `/instance/set` | Set instance property |
| `mcp__roblox_studio__create_instance` | `/instance/create` | Create new instance |
| `mcp__roblox_studio__delete_instance` | `/instance/delete` | Delete instance |
| `mcp__roblox_studio__execute_luau` | `/code/run` | Run Luau code |
| `mcp__roblox_studio__list_children` | `/instance/children` | List children of instance |
| `mcp__roblox_studio__move_instance` | `/instance/move` | Move instance |
| `mcp__roblox_studio__clone_instance` | `/instance/clone` | Clone instance |
| `mcp__roblox_studio__search_instances` | `/instance/search` | Search for instances |
| `mcp__roblox_studio__read_script` | `/script/get` | Read script source |
| `mcp__roblox_studio__write_script` | `/script/set` | Replace script source |
| `mcp__roblox_studio__edit_script` | `/script/edit` | Edit script snippet |
| `mcp__roblox_studio__bulk_create` | `/instance/bulk-create` | Create multiple instances |
| `mcp__roblox_studio__bulk_delete` | `/instance/bulk-delete` | Delete multiple instances |
| `mcp__roblox_studio__bulk_set_property` | `/instance/bulk-set` | Set multiple properties |
| `mcp__roblox_studio__insert_asset` | `/asset/insert` | Insert asset from toolbox |
| `roblox_ask_user` | (Handled by agent) | Ask user questions |
| `roblox_toolbox_search` | (Internal) | Search creator store |
| `mcp__roblox_studio__get_live_context` | (Combo) | Selection + context |

## Step 6: Testing Authentication and Permissions

### 6.1 Test Without Proper Auth Token
```bash
curl -X POST http://localhost:3001/agent/conversations \
  -H "Content-Type: application/json"
  # Missing Authorization header
# Response: 401 Unauthorized
```

### 6.2 Test With Wrong Token
```bash
curl -X POST http://localhost:3001/agent/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong-token" \
  -d '{"studioSessionId": "TEST123"}'
# Response: 401 Unauthorized (if STUD_AGENT_API_KEY is set)
```

### 6.3 Test Mutating Tool Without Relay Header
When the AI calls a mutating tool like `/instance/create`, the agent will forward it to the bridge WITHOUT the `X-Stud-Agent-Relay` header (because the AI shouldn't know about this). The bridge will then reject it with 403 unless you're simulating Studio and add the header when responding.

## Expected Response Formats

### Successful Tool Response
When Studio responds successfully, the agent expects:
```json
{
  "status": 200,
  "body": "{\"result\": \"value\"}"  // Must be a JSON STRING
}
```

### Error Tool Response
```json
{
  "status": 400,
  "body": "{\"error\": \"Something went wrong\"}"  // Must be a JSON STRING
}
```

### Important: The `body` field MUST be a string, not an object!
This is a common point of confusion. The bridge expects:
- ✅ CORRECT: `"body": "{\"name\":\"Part\"}"` (stringified JSON)
- ❌ WRONG: `"body": {"name":"Part"}` (actual object)

## Complete Working Example: AI Asks to Create a Part

Let's walk through a complete example:

**Terminal 1 - Set up conversation:**
```bash
CONV_RESPONSE=$(curl -s -X POST http://localhost:3001/agent/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{"studioSessionId": "TEST123"}')

CONV_ID=$(echo "$CONV_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
ACCESS_TOKEN=$(echo "$CONV_RESPONSE" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

echo "Conversation ID: $CONV_ID"
echo "Access Token: $ACCESS_TOKEN"
```

**Terminal 2 - Start agent run:**
```bash
curl -X POST http://localhost:3001/agent/conversations/$CONV_ID/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{
    "message": "Create a Part named \"TestPart\" in Workspace",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```

**Terminal 3 - Watch events:**
```bash
curl -N http://localhost:3001/agent/conversations/$CONV_ID/events \
  -H "Authorization: Bearer test-token-123" \
  -H "Last-Event-ID: 0"
```
You should see:
1. `run_started`
2. `tool_call` for `mcp__roblox_studio__create_instance` 
3. (Wait for your response...)
4. `tool_result` with the creation result
5. `run_completed`

**Terminal 4 - Respond to bridge (Studio simulation):**
```bash
# First get the pending request ID
curl -s http://localhost:3001/stud/sessions/TEST123/poll
# Extract the ID from the "id" field

# Then respond (remember: create is mutating, so needs relay header)
curl -X POST http://localhost:3001/stud/sessions/TEST123/respond \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: test-token-123" \
  -d '{
    "id": "PUT_THE_ID_FROM_POLL_HERE",
    "response": {
      "status": 200,
      "body": "{\"name\":\"TestPart\",\"class\":\"Part\",\"parent\":\"Workspace\",\"properties\":{}}"
    }
  }'
```

**Back in Terminal 3:** You'll see the tool result and eventually the run completes.

**Back in Terminal 2:** You'll get the final run response with the AI's answer based on the tool result.

## Troubleshooting

### "Conversation not found or unauthorized"
- Check your conversation ID and access token
- Verify the Authorization header format: `Bearer YOUR_TOKEN`
- Make sure you're using the same token that was used to create the conversation

### Tool calls hanging or timing out
- Make sure you're responding to the CORRECT request ID from poll
- Check that you're including `X-Stud-Agent-Relay` header for mutating operations
- Verify the response body is a STRINGIFIED JSON, not a raw object

### 403 errors on mutating operations
- When simulating Studio, you MUST include `X-Stud-Agent-Relay: YOUR_TOKEN` in your respond request
- The token should match `STUD_INTERNAL_RELAY_TOKEN` from your .env or the default generated one

### No events showing up
- Make sure you're connecting to the events endpoint BEFORE the run completes
- Use `-N` flag with curl to prevent buffering
- Check that your Authorization header is correct

## Quick Test Commands

### 10-Second Health Check
```bash
curl -s http://localhost:3001/health
```

### Create Conversation + Run + Watch Events (All in One)
```bash
# Replace TEST123 with your desired session ID
CONV_ID=$(curl -s -X POST http://localhost:3001/agent/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{"studioSessionId": "TEST123"}' | grep -o '"id":"[^"]*' | cut -d'"' -f4)

echo "Conversation: $CONV_ID"

# Start run
RUN_ID=$(curl -s -X POST http://localhost:3001/agent/conversations/$CONV_ID/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -d '{"message":"Get selection","provider":"anthropic","model":"claude-3-5-sonnet-20241022"}' | grep -o '"id":"[^"]*' | cut -d'"' -f4)

echo "Run: $RUN_ID"

# Watch events (run this in another terminal!)
curl -N http://localhost:3001/agent/conversations/$CONV_ID/events \
  -H "Authorization: Bearer test-token-123" \
  -H "Last-Event-ID: 0"
```

Then in another terminal, handle the bridge requests:
```bash
# Get pending request
PENDING=$(curl -s http://localhost:3001/stud/sessions/TEST123/poll)
REQ_ID=$(echo "$PENDING" | grep -o '"id":"[^"]*' | cut -d'"' -f4)

# Respond
curl -X POST http://localhost:3001/stud/sessions/TEST123/respond \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: test-token-123" \
  -d "{\"id\":\"$REQ_ID\",\"response\":{\"status\":200,\"body\":\"[{\\\"name\\\":\\\"TestPart\\\",\\\"class\\\":\\\"Part\\\"}]\"}}"
```

That's it! You now know how to test the complete AI tool calling flow in Stud. The key is understanding that:
1. AI talks to `/agent/*` endpoints
2. Agent talks to bridge via `/stud/sessions/*/request` 
3. Bridge waits for Studio plugin to poll/respond
4. Studio plugin (or your curl simulation) responds with results
5. Results flow back through the same path to the AI

Start with the health check, then try the conversation/events example to see the full flow in action!