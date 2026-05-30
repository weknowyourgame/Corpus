# Roblox Agent Product Architecture

This document describes how to adapt the current agent runtime into a multi-user Roblox Studio agent product. It focuses on five product layers:

1. Automated playtest-observe-fix loops.
2. Multi-tenant session/state isolation.
3. Real-time frontend streaming.
4. Security and user approval boundaries.
5. Future AI-generated assets for models, images, and sounds.

It is intentionally architectural. It does not prescribe implementation code. For related codebase inventories, see:

- `CONTEXT_PROMPT_TECHNICAL_DOC.md`
- `ROBLOX_TOOLING_ADAPTATION_DOC.md`

## Existing Runtime Shape

The current codebase is already an agentic tool loop. The important components are:

- `QueryEngine.ts`: owns a single SDK/headless conversation. It keeps mutable conversation messages, read-file cache, discovered skills, loaded memory paths, permission denials, usage, and an abort controller.
- `query.ts`: owns the model/tool continuation loop. It streams model output, detects tool calls, executes tools, appends tool results, retries/recompacts when needed, and stops when no follow-up tool call is required.
- `services/tools/StreamingToolExecutor.ts`: executes tool calls as they stream in, allows concurrency-safe tools to run in parallel, serializes mutating tools, emits progress, and creates synthetic tool results on aborts/failures.
- `services/tools/toolOrchestration.ts`: older/non-streaming batching path for serial versus concurrent tool execution.
- `state/AppStateStore.ts`: stores interactive application state: permissions, active tasks, MCP clients/tools/resources, plugin state, UI/remote bridge flags, prompt suggestions, speculation state, session hooks, notifications, and bridge callbacks.
- `bootstrap/state.ts`: process-global state: session ID, cwd/project root, telemetry, model usage, cost counters, session persistence flags, registered hooks, cache latches, prompt IDs, and related session-wide values.
- `utils/sessionStorage.ts`: persists transcripts as JSONL under project/session paths.
- `remote/RemoteSessionManager.ts` and `remote/SessionsWebSocket.ts`: manage remote session subscription, SDK message forwarding, permission requests, reconnects, and control requests.
- `bridge/sessionRunner.ts` and `bridge/bridgeMain.ts`: spawn child CLI sessions, parse NDJSON output, extract activity summaries, track active sessions, heartbeat active work, and enforce process-level lifecycle.

The current loop can already do multi-step work that depends on observations: the model asks for tools, the runtime executes them, tool results are added to the message list, and the model continues. What is missing for Roblox is not the generic loop. What is missing is a Roblox-specific verification protocol with structured observations, safe Studio mutation semantics, and clear stop conditions.

## Automated Playtest-Observe-Fix Loop

### Current Multi-Step Behavior

Today, a single user turn can contain many internal model/tool iterations:

1. User submits a prompt.
2. `QueryEngine.submitMessage()` prepares context and calls `query()`.
3. `query()` streams assistant messages.
4. Assistant messages may contain `tool_use` blocks.
5. Tool calls execute through `StreamingToolExecutor` or `runTools()`.
6. Tool results are yielded and normalized back into the message list.
7. If any tool was used, `query()` performs another model call with the updated messages.
8. The loop exits when the assistant produces no more tool calls, or when an error/abort/limit ends the turn.

This is already a general observe-act loop. However, tool results are generic text/data. For playtesting, the agent needs richer observations than raw Studio output.

### Proposed Playtest Loop Architecture

Add a Roblox-specific loop as an orchestration layer above the generic tool loop. The generic loop remains responsible for model/tool continuation; the Roblox playtest layer provides structured state and policy.

Recommended phases:

1. **Intent classification**
   - Decide whether the task requires runtime validation.
   - Identify expected success criteria.
   - Determine whether the task can run autonomously or needs approval.

2. **Baseline observation**
   - Capture current Studio connection state.
   - Snapshot current relevant logs.
   - Optionally snapshot selected DataModel paths touched by the task.

3. **Change application**
   - Apply Studio edits through typed Roblox tools.
   - Record changed instances, scripts, properties, and assets.
   - Mark which changes are reversible.

4. **Playtest start**
   - Start Play Solo, server/client playtest, or a narrower test mode.
   - Set a timeout.
   - Emit playtest status events.

5. **Observation collection**
   - Collect server logs.
   - Collect client logs.
   - Collect script errors and stack traces.
   - Collect warnings.
   - Collect assertion/test harness results when available.
   - Collect Studio/plugin errors.
   - Optionally collect screenshots or scene summaries.

6. **Diagnosis**
   - Compare post-playtest logs with baseline logs.
   - Group duplicate errors.
   - Attribute errors to changed files/instances when possible.
   - Classify each finding as blocking, likely regression, unrelated pre-existing issue, flaky/transient, or inconclusive.

7. **Fix**
   - Apply minimal targeted changes.
   - Do not perform destructive changes without approval.
   - Record what hypothesis the fix addresses.

8. **Repeat**
   - Re-run playtest until pass, inconclusive, no progress, approval required, or iteration budget exhausted.

9. **Final report**
   - Summarize playtest result.
   - List fixed errors.
   - List remaining errors and why the agent stopped.
   - Include the number of iterations.

### Structured Playtest Observation

The playtest result should be treated as a typed artifact, not a plain text blob.

Recommended fields:

- `playtestId`
- `sessionId`
- `studioConnectionId`
- `mode`: play solo, server/client, edit-mode validation, custom test harness
- `status`: passed, failed, crashed, timed_out, inconclusive, cancelled
- `startedAt`
- `endedAt`
- `durationMs`
- `changedInstances`
- `changedScripts`
- `newErrors`
- `preExistingErrors`
- `warnings`
- `logGroups`
- `assertions`
- `screenshots`
- `attribution`
- `confidence`

Error records should include:

- message
- severity
- client/server/source channel
- script path
- line number if available
- stack trace
- first seen timestamp
- repeat count
- whether it existed before the agent changed anything
- whether the path was touched by the agent

### When To Enter A Playtest Loop

Enter the loop when success depends on Roblox runtime behavior.

Strong triggers:

- User explicitly says playtest, run it, verify in Studio, observe errors, or fix automatically.
- The agent edits `Script`, `LocalScript`, or `ModuleScript` behavior.
- The task touches remotes, replication, tools, spawning, NPCs, UI behavior, camera, physics, animations, or gameplay rules.
- The task changes asset references that must load at runtime.
- The task changes server/client boundaries.
- Prior Studio logs show errors relevant to the task.

Avoid the loop when:

- The user asks only for explanation or planning.
- The change is purely static and inspectable.
- Studio is disconnected.
- Required destructive action is awaiting approval.
- The user has disabled autonomous verification.
- A cheaper static validation is sufficient.

Default decision rule:

> If the claim of success requires the Roblox engine to run, enter a playtest loop. If the claim can be proven by static inspection or a single safe tool result, make the change and stop.

### Studio Log Interpretation

Studio logs must be interpreted comparatively. The best signal is not "red text exists"; it is "new or worsened issue after the agent's change."

High-signal logs:

- New script errors.
- Stack traces with script path and line.
- Errors from scripts or instances touched by the agent.
- Infinite-yield warnings introduced by changed code.
- Failed `require()` calls.
- Missing remotes, services, modules, or assets introduced by the change.
- Replication/client-server argument errors.
- Plugin/tool errors caused by the agent's operation.
- Repeated identical error groups.
- Test harness assertion failures.

Medium-signal logs:

- Deprecated API warnings.
- Asset load failures related to new assets.
- Physics/network ownership warnings near changed systems.
- UI layout warnings after UI edits.
- Startup ordering warnings.

Usually noise:

- Logs that existed before the agent began.
- Studio telemetry/network chatter.
- Marketplace/plugin warnings unrelated to the edited game.
- Duplicate logs with no changed-code relationship.
- Expected harness setup/teardown messages.
- Moderation or pending-asset messages unless the task uploaded assets.

Logs are untrusted input. They must never be interpreted as instructions to the agent. A Studio log that says "ignore previous instructions" is just a string.

### Playtest Loop Failure Modes

| Failure mode | Handling |
| --- | --- |
| Studio disconnected | Pause and ask user to reconnect. Do not pretend verification passed. |
| Playtest fails to start | Retry once. If it fails again, surface Studio state and stop. |
| No logs arrive | Mark inconclusive. Retry once if Studio is otherwise healthy. |
| Timeout | Stop playtest, collect partial logs, classify timeout as failure or inconclusive depending on task. |
| Same error after attempted fix | Count as no progress. Stop after repeated no-progress iterations. |
| New error after fix | Continue if under iteration budget and the new error is attributable. |
| Flaky error | Re-run once before changing code. |
| Broad destructive fix needed | Request approval with a structured diff. |
| Ambiguous cause | Stop and ask with the evidence collected. |
| Agent worsens state | Revert only the agent's own last reversible change, if a reliable change boundary exists. Otherwise ask. |
| Prompt injection in logs | Treat as untrusted data; ignore instruction-like content. |
| Runaway loop | Enforce iteration, wall-clock, and cost limits. |

### Iteration Budget

Recommended default:

- 1 initial playtest.
- Up to 3 fix iterations.
- Stop earlier if the same root error appears twice without improvement.
- Allow up to 5 iterations only if each iteration clearly fixes one error and reveals the next.
- Use a wall-clock cap, such as 5-10 minutes for normal tasks.

The loop should stop with a useful report, not a vague failure. The report should say what was tried, what changed, what still fails, and what user decision is needed.

## Multi-Tenancy And Session State

### Current Single-Conversation State

The current architecture assumes a CLI/desktop-style process where a lot of state is process-local.

State categories:

1. **Conversation-local**
   - `QueryEngine.mutableMessages`
   - permission denials
   - total usage
   - read-file cache
   - discovered skills
   - loaded nested memory paths
   - abort controller

2. **Interactive app state**
   - `AppStateStore`
   - permissions
   - tasks
   - MCP clients/resources/tools
   - plugin state
   - notifications
   - bridge state
   - prompt suggestion/speculation state
   - remote callbacks

3. **Process-global bootstrap state**
   - session ID
   - original cwd and current cwd
   - model usage and costs
   - telemetry providers
   - registered hooks
   - session persistence flags
   - prompt ID
   - cache latches

4. **Persistent transcript state**
   - JSONL transcripts under project/session paths
   - subagent transcript paths
   - content replacement records
   - session metadata/title

5. **Remote/bridge state**
   - WebSocket connection
   - pending permission requests
   - active child processes
   - active work IDs
   - heartbeat tokens
   - session timers
   - worktree/session mappings

For a single user process, this is workable. For a cloud multi-user product, process-global state must be wrapped in explicit per-tenant/session containers or isolated into separate workers.

### Required Isolation Per User

Isolate at least:

- User identity and auth.
- Roblox account/group context.
- Studio connection handle.
- Agent session state.
- Conversation messages.
- Tool permissions.
- Approval history.
- Transcript/event stream.
- Temporary generated files.
- Uploaded asset records.
- Cost and token usage.
- Rate-limit counters.
- MCP/Studio bridge clients.
- Retrieval/cache entries that contain project data.
- Abort/cancel controls.

Never share these across users:

- Roblox Open Cloud tokens.
- Studio bridge socket.
- AppState/tool permission context.
- Mutable message arrays.
- Generated asset staging directories.
- Unfiltered logs.
- Per-project retrieval indices.

### Session Definition

Use layered IDs:

- `userId`: authenticated product user.
- `orgId`: team/billing boundary if applicable.
- `projectId`: Roblox experience/place/workspace.
- `studioConnectionId`: one active Studio plugin connection from a user's machine.
- `agentSessionId`: one conversation/task trajectory.
- `browserClientId`: one UI subscriber, usually a tab.

The agent session should be tied to user + project + agent session ID. A browser tab should be treated as a view onto that session, not the owner of the session. The Studio connection is a capability required for Studio-mutating tools, but the conversation can outlive a specific browser tab.

### Browser Close Mid-Task

If the browser closes:

1. Keep the backend agent session running if the task was explicitly started and has remaining budget.
2. Continue streaming events into a durable event log.
3. Mark the browser subscriber as disconnected.
4. Allow a later tab to reconnect and replay events.
5. If the task reaches an approval point, pause until the user returns.
6. If Studio disconnects too, pause or cancel based on task policy.

Do not tie agent lifetime to a single SSE/WebSocket subscriber.

### Studio Connection Lifecycle

The Studio connection should be treated as a scarce, stateful capability:

- One mutating command at a time per Studio connection.
- Playtest state belongs to the Studio connection.
- If Studio disconnects, mutating and playtest tools must fail/pause.
- Reconnection should revalidate the place/project identity.
- A stale Studio connection must not receive queued destructive commands.

### Rate Limiting

Rate limiting should be enforced in multiple places.

API ingress limits:

- Requests per minute per user.
- Requests per minute per IP.
- Active sessions per user/org.

Agent scheduler limits:

- Concurrent active agent loops per user.
- Concurrent mutating sessions per Studio connection.
- Max wall-clock time per task.
- Max model/token/cost budget per task.

Tool limits:

- Studio operations per minute.
- Playtest iterations per task.
- Asset uploads per day.
- AI asset generations per day.
- Max generated asset size.
- Max log volume consumed per playtest.

Provider limits:

- Upstream model API budget.
- Asset generation provider budget.
- Roblox Open Cloud upload limits.

Suggested early defaults:

- 1 active mutating agent per Studio connection.
- 2-3 active agent sessions per user.
- 3 playtest fix iterations per task.
- Strict per-task cost cap.
- Stricter caps for asset generation and upload.

### Database Versus Memory

Persist to a database:

- Users, orgs, projects.
- Agent session metadata and status.
- Durable event stream.
- Transcript/message history or object-storage pointers.
- Studio connection records.
- Permission requests and decisions.
- Tool/action audit log.
- Cost/token usage.
- Rate-limit counters that must survive process restart.
- Asset generation/upload records.
- Moderation status.
- Long-running job checkpoints.

Memory-only state:

- Active SSE/WebSocket subscriber handles.
- Abort controllers.
- In-flight tool promises.
- Short-lived log buffers.
- Current playtest process handle.
- Debounce state.
- Hot caches that can be rebuilt.
- Progress ticks that are also represented by durable summary events.

Critical rule:

> Anything the user would expect to see after refresh, reconnect, or support investigation should be persisted.

## Real-Time Streaming

### Current Streaming Model

The current runtime streams by yielding SDK-style messages from async generators.

`query()` yields:

- request-start events
- assistant messages
- tool-result messages
- progress messages
- compact-boundary messages
- tombstones for discarded partial messages
- final result messages
- API error messages

`StreamingToolExecutor` can emit progress while tools are still running. It stores progress separately from durable tool results because progress is UI-only and should not become part of the model transcript.

Remote sessions use WebSockets through `SessionsWebSocket`. Bridge sessions parse child process NDJSON and extract high-level activity summaries such as tool starts, assistant text, result completion, and errors.

### Roblox Events To Stream

Recommended event groups:

#### Session Events

- `session.created`
- `session.started`
- `session.paused`
- `session.resumed`
- `session.completed`
- `session.failed`
- `session.cancelled`

#### Agent Events

- `agent.message.delta`
- `agent.message.completed`
- `agent.step.started`
- `agent.step.completed`
- `agent.step.failed`

#### Tool Events

- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `tool.cancelled`

#### Studio Events

- `studio.connected`
- `studio.disconnected`
- `studio.state.changed`
- `studio.change.proposed`
- `studio.change.applied`
- `studio.change.failed`
- `studio.change.reverted`

#### Playtest Events

- `playtest.started`
- `playtest.log`
- `playtest.error`
- `playtest.warning`
- `playtest.assertion`
- `playtest.completed`
- `playtest.timed_out`

#### Retrieval Events

- `retrieval.started`
- `retrieval.result`
- `retrieval.completed`

#### Approval Events

- `approval.requested`
- `approval.updated`
- `approval.approved`
- `approval.rejected`
- `approval.expired`

#### Asset Events

- `asset.generation.started`
- `asset.generation.progress`
- `asset.generation.completed`
- `asset.validation.completed`
- `asset.upload.started`
- `asset.upload.completed`
- `asset.moderation.pending`
- `asset.ready`

### SSE Versus WebSockets

SSE is a good fit for browser-facing event streams:

- Simple server-to-client streaming.
- Works over normal HTTP.
- Easy to replay with event IDs.
- Easier to operate behind load balancers.
- Natural fit for append-only session event logs.

WebSockets are a good fit for bidirectional control:

- Studio plugin command/control.
- Low-latency approvals if desired.
- Cancel/interrupt flows.
- Connection health/presence.

Recommended split:

- Browser UI receives session events over SSE.
- Browser sends approve/reject/cancel over normal authenticated HTTP endpoints.
- Studio plugin uses WebSocket or an equivalent bidirectional transport.

This keeps the frontend live without making every user action depend on a long-lived bidirectional browser socket.

### Minimal Live Event Set

For the first live frontend, these events are enough:

- `session.started`
- `agent.message.delta`
- `agent.step.started`
- `agent.step.completed`
- `tool.started`
- `tool.completed`
- `studio.change.proposed`
- `studio.change.applied`
- `playtest.started`
- `playtest.error`
- `playtest.completed`
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `session.completed`
- `session.failed`

The UI should render these as action cards, not as raw logs only. Raw logs can be available in an expandable panel.

### Approval In A Streaming Context

Destructive Studio changes should pause at an approval event.

Approval event payload should include:

- request ID
- session ID
- tool call ID
- operation type
- risk level
- affected instance paths
- old values and new values when available
- script diff when applicable
- whether the operation is reversible
- timeout

Flow:

1. Agent proposes destructive operation.
2. Backend emits `approval.requested`.
3. Tool execution pauses.
4. Frontend renders a diff/action card.
5. User approves, rejects, or requests modification.
6. Backend records the decision.
7. Studio command executes only after approval.
8. Event stream emits `approval.approved` and then `studio.change.applied`, or `approval.rejected`.

Default on timeout should be reject/pause, not approve.

## Security Model

### Current Dangerous Operations

The current codebase can expose powerful operations through tools:

- Shell execution.
- PowerShell execution.
- File writes.
- File edits.
- Notebook edits.
- Network fetch/search.
- MCP tool calls.
- Plugin-provided tools.
- Computer-use style control in feature-gated paths.
- Background/subagent work.
- Remote bridge control.
- Permission bypass modes.

The existing permission system provides tool-specific checks, user prompts, allow/deny rules, permission modes, and remote permission request forwarding.

### Roblox-Specific Destructive Operations

Require user confirmation for:

- Deleting instances.
- Deleting scripts.
- Overwriting large scripts.
- Bulk edits across many instances.
- Moving/renaming objects that may break references.
- Publishing the place/game.
- Uploading assets to the user's account or group.
- Replacing existing Roblox assets.
- Spending Robux or paid quota.
- Modifying DataStores or live production data.
- Changing team create/collaboration settings.
- Inserting untrusted marketplace assets.
- Running arbitrary Studio plugin code.
- Changing permissions or ownership.
- External network uploads/downloads involving user assets.

Lower-risk operations may still be logged but can be auto-applied:

- Reading hierarchy.
- Reading script source.
- Reading logs.
- Creating temporary test objects.
- Non-destructive property inspection.
- Starting/stopping playtest if user enabled auto-playtest.

### Risk Boundary

The cloud agent decides what it wants to do. The user's Studio process and Roblox account are where most real-world risk lives.

Risk locations:

- User's local Studio session.
- User's unpublished game state.
- Roblox cloud asset/account state.
- Group-owned assets and experiences.
- Open Cloud tokens.
- Studio plugin authorization.

Therefore, the Studio bridge/plugin must not be a blind executor. It should enforce capability checks locally:

- Is this command allowed for this session?
- Does this command match an approved request?
- Is the Studio connection still bound to the same user/project?
- Is the operation destructive?
- Is the operation within rate limits?
- Has the command expired?

### Traditional Sandboxing

Cloud sandboxing is still useful, but it solves a different problem.

Use Docker/E2B-style isolation for:

- Running untrusted code analysis.
- Executing tests outside Studio.
- Running conversion tools such as Blender or asset validators.
- Protecting tenants from each other's files/processes.
- Limiting CPU, memory, filesystem, and network access.

It does not solve the core Studio risk:

> A perfectly sandboxed cloud worker can still damage a user's game if the Studio bridge accepts destructive commands without approval.

The product needs both:

- cloud worker isolation
- command-level Studio authorization

### Abuse Vectors

Protect against:

- Prompt injection from Studio logs.
- Prompt injection from scripts/comments/asset names.
- Prompt injection from retrieved docs or marketplace metadata.
- Runaway playtest/fix loops.
- API cost attacks.
- Asset generation cost attacks.
- Cross-tenant cache leakage.
- Credential exfiltration.
- Unauthorized publishing.
- Unauthorized asset upload.
- Malicious marketplace asset insertion.
- Denial of service against Studio.
- Approval spoofing.
- Replay of old approved commands.
- Stale Studio connection command delivery.

### Approval Security Requirements

Approval requests should be:

- Bound to session ID.
- Bound to user ID.
- Bound to Studio connection ID.
- Bound to tool call ID.
- Single-use.
- Expiring.
- Audited.
- Revalidated at execution time.

Approval should describe the actual operation, not a vague capability. "Allow this edit to `Workspace.Shop.NPC.Script`" is acceptable. "Allow all Studio modifications" should be rare and clearly labeled as high-risk.

## Future AI-Generated Assets

### Roblox Asset Handling

Roblox supports external assets through Studio import flows and Open Cloud asset APIs. Asset types include images/decals, audio, meshes, models, and related media. Common creator workflows involve:

- Upload/import through Studio.
- Upload/update through Roblox Open Cloud Assets API.
- Referencing uploaded asset IDs from game instances.

Important format categories:

- Images/textures: PNG, JPG/JPEG, TGA, BMP, and in some import paths GIF.
- Audio: OGG, MP3, FLAC, WAV.
- Mesh/model workflows: FBX and glTF/GLB are important interchange formats; OBJ is common in external tools, though final compatibility depends on the upload/import path.

Roblox asset handling has moderation and ownership semantics. Generated assets should be treated as pending until upload and moderation status are known.

### Current AI Asset Generation Landscape

AI image and sound generation are production-usable when constrained by policy and review.

AI 3D generation is useful but should be treated as an assistive pipeline, not a guaranteed final asset pipeline. It is strongest for:

- simple props
- decorative objects
- rough ideation
- low-stakes environment assets
- placeholder models
- stylized assets with simple geometry

It remains weaker for:

- clean game-ready topology
- predictable poly count
- collision geometry
- rigging
- animation
- strict scale and orientation
- consistent UVs
- exact art direction
- IP-sensitive prompts

Potential sources include Roblox's own generative tooling, Meshy, Tripo, Luma-style services, and local Blender-based cleanup workflows.

### Conceptual Asset Pipeline

Recommended pipeline:

1. User requests asset.
2. Agent creates an asset brief.
3. Policy layer checks prompt/category.
4. Generation provider creates asset.
5. Pipeline downloads generated files.
6. Validator checks format, dimensions, duration, poly count, texture size, and file size.
7. Optional cleanup/conversion runs.
8. Preview is generated.
9. User approves upload/insertion.
10. Asset is uploaded through Roblox Studio or Open Cloud.
11. Roblox asset ID is recorded.
12. Agent inserts asset into the game.
13. Playtest verifies asset loads.
14. Provenance and moderation status are stored.

### Asset Record

Every generated asset should have a durable record:

- asset ID in product database
- provider
- prompt
- negative prompt, if any
- model/version
- seed, if available
- source files
- generated preview
- converted files
- Roblox asset ID
- owning Roblox user/group
- moderation status
- insertion locations
- license/terms metadata
- IP risk classification
- upload timestamp
- approval request ID

### Moderation And IP Risks

Roblox-specific risks:

- Uploaded assets are subject to Roblox moderation.
- Generated content can resemble copyrighted IP.
- Audio can trigger copyright/moderation issues.
- Generated logos, characters, celebrity likenesses, or branded objects can be risky.
- Assets may be private, pending, rejected, or unavailable at runtime.
- Group ownership and permissions can be confusing.

Product policy should:

- Warn before upload.
- Store provenance.
- Block high-risk requests.
- Require approval before upload.
- Avoid generating branded/copyrighted characters.
- Treat moderation pending/rejected as a first-class asset state.

### Layering On The Core Agent

The core code agent should not care which AI asset vendor is used. It should call an asset layer through a typed interface.

Core agent request:

- asset purpose
- desired style
- constraints
- target Roblox usage
- dimensions/duration/poly budget
- whether upload is requested

Asset layer response:

- generated asset record
- preview
- local/generated file refs
- validation result
- risk flags
- Roblox asset ID when uploaded
- insertion instructions

Studio layer then handles:

- insert asset
- set properties
- wire scripts/UI
- playtest asset availability

### Defer Versus Decide Now

Defer:

- exact generation vendor
- advanced Blender cleanup
- automatic rigging
- animation generation
- procedural material pipelines
- marketplace publishing
- in-experience generation
- bulk asset library workflows

Decide now:

- asset provenance schema
- approval model for upload/insert
- per-user/project asset ownership
- event stream shape
- cost/quota model
- moderation status handling
- generated asset abstraction
- Studio command security boundary

## Recommended Product Spine

The same architectural pattern should power playtesting, streaming, security, and asset generation:

1. The agent proposes or performs a typed action.
2. The runtime emits a durable event.
3. The operation is checked against policy.
4. Destructive operations require approval.
5. The Studio bridge executes only approved scoped commands.
6. The system observes structured results.
7. The agent continues only while under budget and making progress.

This gives the product a stable foundation:

- Users can see what is happening.
- The agent can act autonomously within clear limits.
- Studio is protected from blind cloud commands.
- Multi-user sessions do not leak state.
- Future generated assets fit as another typed action pipeline.

