# Stud Bridge Server - Backend Endpoints for Testing

This document provides all available endpoints in the Stud Bridge Server along with curl examples for testing.

## Base URL
```
http://localhost:3001
```

## Session Management Endpoints

### Get Session Status
```bash
curl -X GET "http://localhost:3001/stud/sessions/:sessionId/status"
```
Example:
```bash
curl -X GET "http://localhost:3001/stud/sessions/abc123/status"
```

### Send Request to Studio (via Session)
```bash
curl -X POST "http://localhost:3001/stud/sessions/:sessionId/request" \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
```
Example:
```bash
curl -X POST "http://localhost:3001/stud/sessions/abc123/request" \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
```

### Poll for Request (Studio Plugin uses this)
```bash
curl -X GET "http://localhost:3001/stud/sessions/:sessionId/poll"
```
Example:
```bash
curl -X GET "http://localhost:3001/stud/sessions/abc123/poll"
```

### Respond to Request (Studio Plugin uses this)
```bash
curl -X POST "http://localhost:3001/stud/sessions/:sessionId/respond" \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"{\"success\":true}"}}'
```
Example:
```bash
curl -X POST "http://localhost:3001/stud/sessions/abc123/respond" \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"{\"success\":true}"}}'
```

## Legacy Endpoints (for older plugins)

### Legacy Poll
```bash
curl -X GET "http://localhost:3001/stud/poll"
```

### Legacy Respond
```bash
curl -X POST "http://localhost:3001/stud/respond" \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"{\"success\":true}"}}'
```

### Legacy Request
```bash
curl -X POST "http://localhost:3001/stud/request" \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
```

### Legacy Status
```bash
curl -X GET "http://localhost:3001/stud/status"
```

### Studio Status (same as legacy status)
```bash
curl -X GET "http://localhost:3001/stud/studio/status"
```

## OAuth Endpoints

### OAuth Callback (called by auth provider)
```bash
curl -X GET "http://localhost:3001/auth/callback?code=AUTH_CODE&state=STATE"
```

### Poll for OAuth Status
```bash
curl -X GET "http://localhost:3001/auth/poll"
```

### Clear OAuth Data
```bash
curl -X POST "http://localhost:3001/auth/clear"
```

## Proxy Endpoints

### Codex API Proxy (for ChatGPT integration)
```bash
curl -X POST "http://localhost:3001/codex/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_OPENAI_API_KEY" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

### Whitelisted Fetch Proxy
```bash
curl -X GET "http://localhost:3001/api/proxy?url=https://api.example.com/data"
```
Allowed URLs (must start with one of these):
- https://models.dev/
- https://catalog.roblox.com/
- https://thumbnails.roblox.com/
- https://apis.roblox.com/
- https://openrouter.ai/
- https://api.anthropic.com/

## Health Check
```bash
curl -X GET "http://localhost:3001/health"
```

## Agent Endpoints (mounted at /agent)

The server also mounts an agent router at `/agent` which provides additional endpoints for AI agent functionality. To see these endpoints, you would need to check the `createAgentRouter` function in `./agent/routes.ts`.

## Example Test Sequence

Here's a complete example of how you might test the session flow:

1. **Check health**
```bash
curl -X GET "http://localhost:3001/health"
```

2. **Create a session and check status**
```bash
curl -X GET "http://localhost:3001/stud/sessions/test123/status"
```

3. **Send a request to Studio** (this will wait until Studio polls)
```bash
curl -X POST "http://localhost:3001/stud/sessions/test123/request" \
  -H "Content-Type: application/json" \
  -d '{"path":"/roblox_get_selection","body":null}'
```
*Note: This request will hang until the Studio plugin polls for it*

4. **In another terminal, simulate Studio polling**
```bash
curl -X GET "http://localhost:3001/stud/sessions/test123/poll"
```
*This should return the pending request*

5. **Have Studio respond to the request**
```bash
curl -X POST "http://localhost:3001/stud/sessions/test123/respond" \
  -H "Content-Type: application/json" \
  -d '{"id":"req_1_1716745200000","response":{"status":200,"body":"[{\"name\":\"Part\",\"class\":\"Part\"}]"}}'
```

6. **Check that the original request now completes with the response**

## Notes

- Replace `:sessionId` with an actual session ID (must match `/^[A-Za-z0-9]{6,12}$/` or be "default")
- The server runs on port 3001 by default
- Mutating Studio paths (those that modify Studio state) require the `X-Stud-Agent-Relay` header with the internal relay token
- Session IDs must be 6-12 alphanumeric characters
- Requests timeout after 15 seconds if Studio doesn't respond
- Completed requests are cached for 5 minutes by operationId