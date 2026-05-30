# Cloud To Local Roblox Studio Protocols

This doc explains how a cloud-hosted agent can communicate with Roblox Studio running on a user’s local machine.

## 1. Available Protocol Patterns

Common options:

- WebSocket: local plugin or companion app opens an outbound persistent connection to the cloud.
- HTTP polling: local process periodically asks cloud for work.
- SSE: cloud streams events to local process over a long-lived HTTP response.
- Tunnel: local process exposes a local HTTP/WebSocket server through a relay or tunnel.
- WebRTC/data channel: peer-like connection with signaling, usually more complex than needed here.

For this use case, the safest MVP is usually outbound WebSocket from a local Studio plugin companion to the cloud. It avoids inbound firewall problems and supports bidirectional low-latency messages.

## 2. WebSocket

Pros:

- Bidirectional.
- Low latency.
- Good for tool calls, progress, logs, cancellation.
- Easy session heartbeat.
- Works through most networks if initiated outbound.

Cons:

- Needs reconnect logic.
- Needs message IDs and idempotency.
- Needs backpressure handling.
- Studio plugin environment may need a local companion depending on Roblox networking/plugin limitations.

Best fit:

- Agent asks Studio to read tree, edit scripts, run tests, stream logs.

## 3. HTTP Polling

Pros:

- Simple.
- Works with strict networks.
- Easy to reason about.
- No long-lived connection required.

Cons:

- Higher latency.
- Inefficient for logs/progress.
- Cancellation is slower.
- Cloud has to queue requests until the local side polls.

Best fit:

- Fallback mode.
- Low-frequency sync.
- Environments where WebSockets are blocked.

## 4. SSE

Pros:

- Simple server-to-client stream.
- Good for cloud sending queued commands or status.
- Easier than WebSocket in some stacks.

Cons:

- One-way only.
- Local side still needs HTTP POST for responses.
- Less natural for RPC-style tool calls.

Best fit:

- Streaming logs/events from cloud to local, paired with POST responses.

## 5. Tunnel

Pros:

- Lets cloud call a local HTTP server as if it were public.
- Can support existing HTTP tooling.
- Useful for debugging and local development.

Cons:

- Security-sensitive.
- URL lifecycle and auth are tricky.
- Inbound-like exposure increases risk.
- Harder for nontechnical creators.

Best fit:

- Development and enterprise setups, not first MVP for creators.

## 6. How Other Tools Solve Similar Problems

Cursor and local LSP:

- The editor runs locally.
- Language servers run as local processes.
- The client speaks JSON-RPC over stdio, pipes, or sockets.
- The local editor has direct filesystem access, so no cloud-to-local bridge is needed unless cloud features are involved.

ngrok-style tunnels:

- A local agent creates an outbound connection to a relay.
- The relay gives a public URL.
- External callers hit the relay, which forwards traffic over the existing outbound connection.
- This solves NAT/firewall issues but creates an exposed endpoint that must be authenticated.

Browser DevTools:

- Browsers expose a debugging protocol, often over WebSocket.
- Tools connect to a target, inspect runtime state, evaluate commands, observe logs/network, and mutate page state.
- A Roblox Studio bridge would be conceptually similar: inspect tree, evaluate safe plugin actions, stream output, mutate scripts.

## 7. Failure Modes

Important failures:

- User closes Studio.
- User closes the companion/plugin.
- Internet drops.
- Cloud worker restarts.
- WebSocket disconnects.
- Plugin crashes or reloads.
- Tool call times out.
- Studio enters play mode while edit operation expects edit mode.
- Place changes under the agent while it is acting.
- User manually edits the same script.
- Script write succeeds locally but publish/save fails.
- Logs overflow or are cleared.
- Permissions expire.

Required mitigations:

- heartbeat and presence state,
- reconnect with session resume,
- idempotent tool call IDs,
- operation timeout and cancellation,
- explicit mode checks,
- conflict detection on script source/version,
- clear error results returned to the model,
- user-visible connection state.

## 8. Minimal Plugin Surface

Minimum useful Studio bridge:

- Read current game tree.
- Read selected instances.
- Read script source by full instance path or stable instance ID.
- Write script source with conflict/version check.
- Insert Script, LocalScript, ModuleScript under a target instance.
- Return output logs and errors.
- Run/stop playtest.
- Return diagnostics/type errors.
- Report Studio mode and connection health.

Nice later:

- UI hierarchy visual snapshot.
- Asset insertion/import.
- DataModel diff/patch operations.
- Multi-client test sessions.
- RemoteEvent/RemoteFunction tracing.
- Performance/memory stats.
- Screenshot or viewport capture.

