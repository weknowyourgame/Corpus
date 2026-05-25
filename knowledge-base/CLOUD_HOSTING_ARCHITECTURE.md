# Cloud Hosting Architecture

This doc explains what would need to change to run this local CLI-style agent as a cloud-hosted service.

## 1. Current Agent State

The codebase is built around a local process that owns conversation state in memory and persists transcript/session artifacts to local disk.

Key local state:

- `QueryEngine` owns `mutableMessages`, the current conversation history.
- `QueryEngine` owns `readFileState`, a cache of file reads.
- `AppStateStore` owns UI/runtime state such as tasks, MCP connection state, hooks, remote session info, and tool permission state.
- Transcripts are recorded locally through session storage utilities.
- Current working directory and original cwd come from local bootstrap state.

Relevant code:

- `/Users/sarthakkapila/src/QueryEngine.ts:176` says `QueryEngine` owns query lifecycle and session state.
- `/Users/sarthakkapila/src/QueryEngine.ts:186` stores `mutableMessages`.
- `/Users/sarthakkapila/src/QueryEngine.ts:191` stores `readFileState`.
- `/Users/sarthakkapila/src/QueryEngine.ts:451` records transcript messages.
- `/Users/sarthakkapila/src/state/AppStateStore.ts:117` and nearby fields track remote/session/task state.
- `/Users/sarthakkapila/src/utils/cwd.ts:20` resolves cwd from local process state.

## 2. Local Assumptions That Break In Cloud

Major local assumptions:

- The agent can read and write the user’s filesystem directly.
- Shell commands run on the same machine as the project.
- Git state is local and trusted.
- MCP servers can be launched or reached from the local process.
- The current working directory represents the user’s project.
- Permissions are oriented around local commands/files.
- Terminal output and process signals are local.
- Transcripts and caches can be written to local disk.
- App state can live in process memory.
- A single user/session can own the process lifecycle.

In cloud, these need explicit multi-tenant equivalents:

- Workspace storage per user/project.
- Isolated execution sandboxes.
- Remote tool gateways.
- Persistent database-backed conversation state.
- Per-user auth, audit, and permission records.
- Durable job queues for long-running agents.
- Explicit network path to user-local Roblox Studio.

## 3. Concurrency

The local architecture can run concurrent tool calls and background subagents inside one process, but it is not automatically a multi-user cloud architecture.

Current concurrency works for:

- parallel read-only tools,
- streaming tool execution,
- background agents,
- MCP progress updates,
- local task state.

Cloud multi-user concurrency needs more:

- tenant isolation,
- per-session locks,
- per-project operation ordering,
- distributed cancellation,
- durable task state,
- rate limiting,
- replay/resume after worker restart.

The existing loop can remain as a per-session worker, but the state around it should move out of process memory.

## 4. Session Lifecycle Today

Current lifecycle:

1. Process starts in a cwd.
2. App/session state initializes.
3. MCP clients and tools load.
4. User input is appended to `mutableMessages`.
5. Transcript is recorded.
6. `query` runs the agent loop.
7. Tool results and assistant messages are appended.
8. Transcript is flushed.
9. Long conversations may compact.
10. Session ends when process/UI exits or user stops interacting.

Cloud lifecycle should become:

1. User authenticates.
2. Session row/job is created.
3. Project/Studio connector is attached.
4. Agent worker loads durable conversation state.
5. Worker builds prompt/context from database plus live connector.
6. Tool calls route through cloud services or user-local bridge.
7. Messages/results stream to the client.
8. State and transcripts persist after every step.
9. Worker can stop/restart/resume.

## 5. Architectural Changes Needed

Fundamental changes:

- Replace local cwd as the source of truth with project/workspace records.
- Replace direct filesystem tools with workspace or Roblox Studio connector tools.
- Move conversation state to a durable store.
- Move transcript storage to object storage/database.
- Add a job queue for agent runs and background agents.
- Add a secure tool gateway for cloud-to-local Studio calls.
- Add tenant-aware permissions and audit logs.
- Add resumable streaming to the web client.
- Add server-side MCP registry and per-session MCP tool availability.
- Add sandboxing for any server-side shell/code execution.

Mostly reusable:

- Main model/tool loop.
- Tool abstraction.
- MCP tool registration pattern.
- Context compaction concepts.
- Subagent concept.
- Stop hooks and permission hooks, after adapting their storage and policy layer.

Likely rewritten:

- Local shell/file tools.
- cwd/project discovery.
- transcript/session persistence.
- local permission prompts.
- local UI state assumptions.
- direct MCP process launching for user-local services.

