# Claude Code Architecture Adoption Pass

## 1. Provenance & License Status

The directory `claude-code-opensource/` in this repository is **not** open
source. It contains internal Anthropic Claude Code source code (e.g.
`import { feature } from 'bun:bundle'`, `import { ... } from 'src/bootstrap/state.js'`,
references to internal packages and entrypoints). The directory does not
contain a `LICENSE`, `NOTICE`, `COPYING`, or `README` file, and the published
Claude Code product is distributed under the proprietary **Anthropic
Commercial License**, not an OSS license.

**Decision:** No source file under `claude-code-opensource/` was copied
verbatim, included by reference, or partially translated into this
codebase. All Stud modules that take inspiration from a Claude Code
subsystem are clean-room implementations: we read the reference to
identify *patterns* and *behaviors*, then wrote the equivalent Stud module
from scratch against Stud's existing types and policy engine.

This file records the inspection log and the mapping that resulted from it.

## 2. Inspection Log

The following Claude Code files were inspected to identify behavioral
patterns. The notes below are summaries of behavior; no source text was
imported.

| Reference | Pattern observed (not copied) |
|---|---|
| `QueryEngine.ts` | Streaming engine that interleaves model deltas, tool calls, permission requests, and compaction boundaries; treats the turn as an iterator that can be cancelled and resumed via a child `AbortController`. |
| `query.ts` | Top-level loop that drives `QueryEngine`, handles tool-result feedback into next turn, surfaces structured errors. |
| `services/tools/StreamingToolExecutor.ts` | Tracks tool uses as they stream in, groups concurrent-safe tools into parallel batches, serializes non-concurrent tools, uses a sibling `AbortController` so a failed Bash subprocess does not abort the parent turn, and yields results in arrival order rather than completion order. |
| `services/mcp/MCPConnectionManager.tsx`, `client.ts`, `config.ts`, `types.ts` | MCP server is described by a config record; tools are discovered on connect; tool name normalization is centralized; transport adapters (stdio, SSE, in-process, sdk-control) implement a common surface. |
| `tools/MCPTool/MCPTool.ts` | Each MCP tool registers with a `mcp__server__tool` name, schema, and risk-aware permission UI. |
| `tools/AskUserQuestionTool/*` | Tool that returns control to the user with structured questions; the answer is delivered as a tool result on the next turn. |
| `tools/EnterPlanModeTool/*` and `tools/ExitPlanModeTool/*` | Plan mode is entered explicitly; in plan mode, mutation tools are blocked; on exit, a structured plan is presented and the user explicitly approves continuation. |
| `tools/AgentTool/*` | Subagent tool spawns a constrained child session with its own tool registry, propagates progress, supports cancellation, and returns a final structured result that the parent can act on. |

## 3. Subsystem Mapping

| Claude Code subsystem | Stud equivalent today | Gap | Decision |
|---|---|---|---|
| `QueryEngine` streaming loop with cancellation | `AgentRuntime.execute()` already has `AbortController` plumbing, per-turn iteration, and streaming via `onTextDelta` | Disk write on every text delta; tool calls in a turn always serialized | Reimplement persistence policy (this PR); add scheduler (this PR). No port. |
| `StreamingToolExecutor` parallel-safe / exclusive grouping | `AgentTool.concurrency` metadata already present but ignored at execution time | Tools execute strictly sequentially | New `ToolScheduler` module, clean-room (this PR). |
| `services/mcp/*` MCP transport + discovery | `RobloxStudioMcpGateway` already wraps Studio MCP tools, with risk metadata and per-call relay | No external MCP server registration — Stud only has Studio MCP and toolbox | No change needed in this PR; gateway design is already aligned. Risk metadata stays authoritative. |
| `tools/MCPTool` name normalization | Stud tools already use the `mcp__roblox_studio__*` namespace | None | No change. |
| `tools/AskUserQuestionTool` | `roblox_ask_user` tool + `requestInteraction` already implement this | Pending interactions are in-memory only; lost on server restart | Persist pending interactions in conversation store (this PR). |
| `EnterPlanMode` / `ExitPlanMode` | `mode: "plan"` blocks mutations and emits `plan_proposed` | Plan output is unstructured text; approval doesn't widen any future execute-mode scope | New `submit_plan` tool + plan-approval endpoint + `approvedPlan` field on conversation honored by the policy engine (this PR). |
| `tools/AgentTool` subagent lifecycle | `SubagentRuntime` already exists, read-only registry, plan proposals, abort signal | No progress events emitted to the parent run; no wall-clock budget | Add progress events + time budget (this PR). |
| `compaction` boundary handling | None | Long conversations can exceed model context | Out of scope for this PR; tracked separately. Conversation store is now event-log-based which makes future compaction safe. |
| Persisted conversation store | `DevelopmentConversationStore` (JSON file) and `MemoryConversationStore` (RAM) | Whole-file rewrite on every event, including each token delta | Replace with snapshot + append-only JSONL events. Backwards-compatible API. (This PR.) |
| Resumable event stream | `AgentRuntime.subscribe(conversationId, after, listener)` replays from sequence | Already works; not previously covered by an explicit reconnect-mid-stream test | Add an explicit test (this PR). |

## 4. Things Explicitly Not Adopted

- **Terminal/Ink UI components** — Stud is a React web client. Anything under
  `ink/`, `screens/`, `components/`, `interactiveHelpers.tsx` is irrelevant.
- **Filesystem and shell tools** — Stud never grants the agent shell access
  or unrestricted filesystem access. We do not import `BashTool` or
  filesystem read/write tools.
- **Hooks system that runs arbitrary local commands** — also a security
  surface we don't want.
- **Memory backed by `~/.claude/`** — Stud uses per-conversation
  persistence under `.stud/` and per-script indexing; no global mutable
  state in the user home directory.
- **Cost tracker** — Stud tracks usage at the bridge layer; the in-engine
  cost tracker is not adopted.

## 5. Out of Scope for This PR

- Context window compaction (token-aware truncation with summaries).
- Full migration off in-memory pending state for runs that should survive
  server restart and keep executing — that requires durable LLM-stream
  resumption and is a separate effort. This PR makes pending approvals /
  interactions visible across reconnect, and on server restart marks
  in-flight runs as cancelled so the UI shows accurate state.

## 6. What This PR Delivers

1. Snapshot + append-only JSONL persistence; no whole-file rewrite on text
   deltas.
2. Tool scheduler that runs concurrent-safe tools in parallel and
   serializes mutation tools, driven by existing
   `AgentTool.concurrency` metadata. Cancellation propagates.
3. Structured `submit_plan` tool that records intended steps; a new
   `/plan/approve` endpoint promotes the plan into a typed
   `approvedPlan` on the conversation; `PermissionPolicy` honors it as a
   narrower-than-`allow_scope` permission tier.
4. Persisted pending approvals and interactions on the conversation
   record, so reconnects after disconnect see the same pending UI state,
   and on server restart in-flight runs are cleanly cancelled.
5. Subagent progress events and a wall-clock budget, with cancellation
   tests.
6. Tests for: interrupt + resume, parallel reads vs serialized writes,
   persisted pending approvals across reconnect, structured approved-plan
   scope enforcement, subagent progress + cancellation, and the new
   snapshot/event-log durability path.

## 7. How to Verify

```
npm run typecheck
npm run test:run
npm run build
```
