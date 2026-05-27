# Stud Bridge Server - Complete Testing Guide

This guide walks you through real end-to-end testing of the Stud Bridge Server using actual curl commands. Follow these steps to test the complete web app ↔ bridge ↔ Studio plugin communication flow.

## Prerequisites

1. **Stud Bridge Server running**: `npm run dev:bridge` (runs on port 3001)
2. **Two terminal windows**: One for simulating web app, one for simulating Studio plugin
3. **Valid session ID**: 6-12 alphanumeric characters (e.g., `test123`, `abcdefg`, `a1b2c3d4`)

## Step-by-Step End-to-End Test

### Terminal 1: Simulate Web App (Sending Requests to Bridge)

#### 1. Check Server Health
```bash
curl -s http://localhost:3001/health
# Expected: {"ok":true,"sessions":0}
```

#### 2. Create a Session and Check Status
```bash
curl -s http://localhost:3001/stud/sessions/test123/status
# Expected: 
# {
#   "connected":false,
#   "pluginConnected":false,
#   "mcpConnected":false,
#   "configuredTransport":"plugin",
#   "preferredTransport":"plugin",
#   "effectiveTransport":"plugin",
#   "lastUsedTransport":null,
#   "mcpServer":null,
#   "mcpTools":[],
#   "mcpError":null,
#   "pending_requests":0,
#   "last_poll_time":null
# }
```

#### 3. Send a Request to Studio (This Will Wait)
```bash
# In Terminal 1, run this - it will hang waiting for Studio response
curl -X POST http://localhost:3001/stud/sessions/test123/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
# DO NOT PRESS CTRL+C YET - leave this running
```

### Terminal 2: Simulate Studio Plugin (Polling and Responding)

#### 4. Poll for Pending Requests (Studio Plugin Does This Every 100ms)
```bash
# In Terminal 2, run this repeatedly or in a loop
curl -s http://localhost:3001/stud/sessions/test123/poll
# Expected first response (before web app sends request):
# {"id":null,"request":null}

# After web app sends request (from Terminal 1), you should see:
# {"id":"req_1_1716745200000","request":{"path":"/roblox_get_selection","body":null}}
# NOTE: The actual ID will be different (timestamp-based)
```

#### 5. Extract the Request ID from Poll Response
When you see the poll response with an ID, copy that ID value (e.g., `req_1_1716745200000`).

#### 6. Respond to the Request (Studio Plugin Does This After Processing)
```bash
# In Terminal 2, using the ID from step 5
curl -X POST http://localhost:3001/stud/sessions/test123/respond \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"[{\"name\":\"Part\",\"class\":\"Part\",\"properties\":{}}]"}'
# Expected: {"ok":true}
```

### Terminal 1: See the Completed Request

#### 7. Web App Request Should Now Complete
```bash
# Back in Terminal 1, the hanging curl should now complete with:
# [{"name":"Part","class":"Part","properties":{}}]
# (HTTP 200 OK)
```

## Testing Mutating Requests (Requires Agent Relay Token)

Some paths require the `X-Stud-Agent-Relay` header. These are mutating operations like:
- `/script/set`, `/script/edit`
- `/instance/create`, `/instance/delete`, etc.
- `/code/run`
- Bulk operations

### Test a Mutating Request (Will Fail Without Proper Header)

#### 8. Try a Mutating Request Without Agent Relay (Should Fail)
```bash
# In Terminal 1 (new request)
curl -X POST http://localhost:3001/stud/sessions/test123/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/instance/create","body":{"className":"Part","parent":"Workspace"}}'
# Expected: 
# {"error":"Mutating Studio requests must run through the agent permission gateway"}
# (HTTP 403)
```

#### 9. Same Request WITH Agent Relay Header (Should Succeed If Studio Responds)
```bash
# First get the AGENT_RELAY_TOKEN from server logs or environment
# For testing, you can use any value since we're not actually connecting to Studio
# But the header must be present

curl -X POST http://localhost:3001/stud/sessions/test123/request \
  -H "Content-Type: application/json" \
  -H "X-Stud-Agent-Relay: any-value-here" \
  -d '{"path":"/instance/create","body":{"className":"Part","parent":"Workspace"}}'
# This will hang waiting for Studio response (same as step 3)
```

## Testing Legacy Endpoints (For Older Plugins)

### 10. Test Legacy Poll/Respond Flow
```bash
# Terminal 1: Send legacy request (will hang)
curl -X POST http://localhost:3001/stud/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'

# Terminal 2: Poll legacy endpoint
curl -s http://localhost:3001/stud/poll
# Should show the pending request

# Terminal 2: Respond to legacy request
curl -X POST http://localhost:3001/stud/respond \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"test"}}'

# Terminal 1: Request completes
```

## Testing Caching (OperationId Deduplication)

### 11. Test Request Caching with operationId
```bash
# Terminal 1: First request with operationId
curl -X POST http://localhost:3001/stud/sessions/test123/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null,"operationId":"op_123"}'
# Will hang

# Terminal 2: Poll and respond
curl -s http://localhost:3001/stud/sessions/test123/poll
# Get the ID, then respond
curl -X POST http://localhost:3001/stud/sessions/test123/respond \
  -H "Content-Type: application/json" \
  -d '{"id":"<from-poll>","response":{"status":200,"body":"first"}}'

# Terminal 1: First request completes with "first"

# Terminal 1: Second request with SAME operationId (should return cached result instantly)
curl -X POST http://localhost:3001/stud/sessions/test123/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null,"operationId":"op_123"}'
# Should IMMEDIATELY return: "first" (no hanging)
```

## Testing Proxy Endpoints

### 12. Test Whitelisted Proxy
```bash
curl -s "http://localhost:3001/api/proxy?url=https://httpbin.org/json"
# Should return JSON from httpbin.org (since it's not in whitelist, actually...)
# Wait - httpbin.org is NOT in the whitelist! Let's use a whitelisted URL:

curl -s "http://localhost:3001/api/proxy?url=https://catalog.roblox.com/v1/catalog/1/productinfo"
# Expected: Product info from Roblox catalog (or error if not authenticated)
```

### 13. Test Codex Proxy (Requires OpenAI API Key)
```bash
curl -X POST http://localhost:3001/codex/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-openai-key-here" \
  -d '{"model":"gpt-4o","input":"Say hello"}'
# Expected: Streaming response from Codex API
```

## Common Session ID Values to Test

| Session ID | Valid? | Notes |
|------------|--------|-------|
| `default` | Yes | Legacy session for older plugins |
| `test123` | Yes | 6 chars alphanumeric |
| `abcdefg` | Yes | 7 chars |
| `a1b2c3d4` | Yes | 8 chars |
| `test` | No | Too short (<6) |
| `test_123` | No | Underscore not allowed |
| `test12345678901` | No | Too long (>12) |
| `TEST123` | Yes | Uppercase allowed |
| `Test123` | Yes | Mixed case allowed |

## Expected Behavior Summary

1. **Web App → Bridge**: POST to `/stud/sessions/:id/request`
2. **Bridge**: Queues request, responds only when Studio polls/responds
3. **Studio Plugin → Bridge**: GET `/stud/sessions/:id/poll` every 100ms
4. **Bridge**: Returns oldest pending request on poll
5. **Studio Plugin → Bridge**: POST to `/stud/sessions/:id/respond` with ID and response
6. **Bridge**: Sends response back to waiting web app request
7. **Bridge**: Caches successful mutating requests by operationId for 5 minutes

## Troubleshooting

- **"Invalid session id"**: Check session ID format (6-12 alphanumeric chars only)
- **Request hangs forever**: Studio plugin isn't polling or responding
- **403 on mutating requests**: Missing `X-Stud-Agent-Relay` header
- **504 timeout**: Studio didn't respond within 15 seconds
- **Empty poll response**: No pending requests in queue
- **"Request not found" on respond**: Using wrong/expired ID or already responded

## Quick Test Commands (Copy-Paste Ready)

### In one terminal (web app simulator):
```bash
# Health check
curl -s http://localhost:3001/health

# Session status
curl -s http://localhost:3001/stud/sessions/abc123/status

# Send request (will hang - leave running)
curl -X POST http://localhost:3001/stud/sessions/abc123/request \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
```

### In another terminal (studio plugin simulator):
```bash
# Poll for request
curl -s http://localhost:3001/stud/sessions/abc123/poll

# When you see an ID in the response, respond with it:
curl -X POST http://localhost:3001/stud/sessions/abc123/respond \
  -H "Content-Type: application/json" \
  -d '{"id":"COPY_THE_ID_FROM_POLL","response":{"status":200,"body":"[{\"name\":\"TestPart\"}]"}}'
```

The web app terminal should then show the response and complete.

---

**Remember**: The Studio plugin in Roblox Studio actually does steps 4 and 6 automatically every 100ms. This guide simulates that behavior with curl for testing purposes.