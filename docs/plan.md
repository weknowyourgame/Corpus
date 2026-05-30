# Stud: Lovable for Roblox Games - Product and Engineering Plan

## 1. Product Goal

Stud should become a web-first Roblox game-building agent:

1. A creator describes a game or feature in chat.
2. The agent inspects the connected Roblox Studio place and relevant Roblox knowledge.
3. The agent plans when the task is broad, asks focused questions when a choice matters, and requests approval before risky changes.
4. The agent finds Creator Store assets, proposes visual options, inserts approved assets, creates/edits instances and Luau, and later works with DataStores.
5. The agent verifies the result in Studio, reports what it changed, and can delegate bounded work to specialist subagents.

The first product moment to optimize for is:

> "Make a Minecraft-style starter world" -> agent proposes a plan -> searches Toolbox -> user chooses assets with thumbnails -> user approves the change set -> approved assets and starter scripts appear in Studio -> activity and undo are visible.

## 2. What Exists Today

This repository is not starting from zero. The following exists in source and should be preserved or hardened rather than rebuilt blindly.

### Current Stud App

| Area | Present today | Key files |
| --- | --- | --- |
| Web UI | React chat, connection flow, prompt chips, provider/settings UI | `src/pages/Home.tsx`, `src/components/`, `src/stud-ui/` |
| Model calls | AI SDK streaming for Anthropic/OpenRouter and a Codex Responses loop | `src/lib/ai/providers.ts`, `src/lib/ai/codex-chat.ts` |
| Studio transport | Session-scoped HTTP request queue, plugin polling, response relay | `server/index.js`, `src/lib/roblox/client.ts` |
| Studio plugin | Script operations, instance operations, bulk mutations, selection, arbitrary Luau execution, asset insertion, undo waypoints | `studio-plugin/stud-bridge.server.lua` |
| Roblox tools | 18 exposed tools: script, instance, bulk, Toolbox, insert asset, ask user | `src/lib/roblox/tools.ts` |
| Toolbox | Catalog/economy/thumbnail client plus insert tool | `src/lib/roblox/toolbox.ts`, `src/lib/roblox/tools.ts` |
| Interactive choice UI | Rich options including thumbnail cards, currently wired through an in-memory handler | `src/components/chat/QuestionPrompt.tsx`, `src/stores/chat.ts`, `src/pages/Home.tsx` |
| Instance UI | Tree/picker exists; button inserts `@path` text | `src/components/chat/InstanceTree.tsx`, `src/components/chat/InstancePicker.tsx` |
| Diff UI | Visual diff component exists, but is not the governing approval mechanism | `src/components/chat/DiffView.tsx` |

### Current Gaps

| Needed capability | Status/gap |
| --- | --- |
| True agent runtime for a hosted web product | Model/tool execution currently lives primarily in the browser; no durable server conversation worker |
| MCP-based Studio integration | Current bridge is custom HTTP RPC, not an MCP server/client integration |
| Permission system | The model can ask a question, but there is no enforced policy gate before each mutation; `/code/run` is especially powerful |
| Plan approval | A prompt chip suggests planning, but there is no read-only plan mode or approved execution contract |
| Toolbox production flow | Search/insert is present, but asset safety review, approval policy, pagination/ranking, and end-to-end tests are missing |
| DataStore operations | No Open Cloud credentials, scope policy, audit, preview, or tools |
| Subagents | No parent/child task runtime in Stud |
| Context/RAG | No live Studio context injection pipeline or curated Roblox retrieval service |
| Verification loop | No structured playtest/log/diagnostic observe-fix cycle |
| Multi-tenant hosting security | Session code relay has no product-grade identity, authorization, persistent audit, or reconnect/resume protocol |

## 3. What To Reuse From `claude-code-opensource`

Use the imported source as an architectural reference and selectively port runtime ideas. Do not attempt to drop its terminal application wholesale into the React app.

| Reuse concept | Reference area | Stud adaptation |
| --- | --- | --- |
| Stateful model/tool loop | `claude-code-opensource/QueryEngine.ts`, `query.ts` | A server-side Stud conversation runner that persists turns and streams events to the browser |
| Typed tool contract | `Tool.ts`, `services/tools/toolExecution.ts` | Roblox tool registry with read/mutate/destructive classification, validation, permission checks, structured results |
| Ordered/concurrent execution | `services/tools/StreamingToolExecutor.ts` | Permit parallel reads; serialize Studio and DataStore mutations |
| Permission and question interactions | `tools/AskUserQuestionTool/`, permission types in `Tool.ts` | Web approval cards, remembered session rules, explicit destructive confirmation |
| Plan mode | `tools/EnterPlanModeTool/`, `tools/ExitPlanModeTool/` | Read-only Studio exploration followed by a user-approved Roblox change plan |
| MCP tool handling | `services/mcp/`, `tools/MCPTool/` | Register the Studio connector as namespaced MCP tools on the server |
| Subagents | `tools/AgentTool/`, `tasks/` | Later: bounded Roblox specialist tasks sharing read context, with parent-owned mutations |
| Compaction/session memory | `services/compact/`, session storage patterns | Persist conversations and rebuild fresh live Studio context each turn |

Before copying code, complete a provenance and license review of `claude-code-opensource/`. It contains build-specific imports such as `bun:bundle` and internal module conventions, so it is not a ready-made dependency for this Vite app.

## 4. Knowledge Base: Use Now vs Later

The knowledge base is useful, but it should not all become prompt text.

### Keep Active During Core Build

| Document | Why |
| --- | --- |
| `AGENT_ORCHESTRATION_LOOP.md` | Defines the loop behavior worth porting |
| `ROBLOX_TOOLING_ADAPTATION_DOC.md` | Defines Roblox tool metadata and result expectations |
| `MCP_SERVER_INTEGRATION.md` | Guides Studio MCP registration and calls |
| `ROBLOX_SYSTEM_PROMPT_CONTEXT_INJECTION.md` | Guides compact stable prompt plus live context |
| `CLOUD_TO_LOCAL_STUDIO_PROTOCOLS.md` | Guides secure session transport evolution |
| `TOOL_FAILURE_RETRY_LOGIC.md` | Guides error and retry semantics |

### Use In Later Phases

| Document | Trigger |
| --- | --- |
| `ROBLOX_RAG_PIPELINE.md`, `ROBLOX_CORPUS_INDEXING.md` | When live Studio context works and retrieval is being added |
| `SUBAGENTS_AND_FORKS.md` | When single-agent execution is stable |
| `ROBLOX_AGENT_PRODUCT_ARCHITECTURE_DOC.md` | When implementing playtests and production tenancy |
| `CONTEXT_COMPACTION_TRUNCATION.md`, `CLOUD_HOSTING_ARCHITECTURE.md` | When sessions are persisted and deployed |

Rule: stable Roblox safety and execution facts belong in the system prompt; changing project tree, selection, scripts, logs, and retrieved documentation belong in per-turn context.

## 5. Target Architecture

```text
Browser (React)
  chat stream, approvals, plan cards, asset picker, change log
       |
       | authenticated SSE/WebSocket events + user decisions
       v
Stud API / Agent Runtime (Node/TypeScript)
  conversations, tool loop, permission engine, plan state,
  tool registry, audit log, Open Cloud gateway, retrieval, subagents
       |
       | MCP client calls: mcp__roblox_studio__*
       v
Roblox Studio MCP Gateway / Session Relay
  session auth, queued RPC, cancellation, idempotency, presence
       |
       | outbound connection or polling fallback
       v
Roblox Studio Plugin
  typed operations, undo/change transactions, logs/playtest, selection/tree
```

### Non-Negotiable Design Decisions

1. The browser is a UI client, not the trusted owner of agent policy, provider secrets, DataStore credentials, or mutation approvals.
2. Existing plugin handlers can power the first MVP, but they should be presented through a typed MCP gateway rather than permanently expanding ad hoc browser tools.
3. Read operations may be automatic. Mutations must pass a server-side permission policy. DataStore writes, deletes, arbitrary code execution, untrusted asset scripts, publishing, and broad bulk operations require explicit approval.
4. Never insert a Toolbox model containing scripts without showing the risk and applying the user's asset-script policy: strip scripts, inspect and approve, or reject.
5. DataStore access must use scoped server-side Open Cloud credentials; never expose API keys to the browser or Studio plugin.
6. A subagent may inspect and propose changes; the parent agent/permission engine remains the authority for mutations.
7. Live Studio state is regenerated per turn and is not trusted merely because it appeared earlier in chat history.

## 6. Tool and Permission Model

Every tool should declare metadata the runtime enforces:

```ts
type Risk = "read" | "low_mutation" | "destructive" | "secret" | "runtime_code";

type StudTool = {
  name: string;
  transport: "server" | "studio_mcp" | "open_cloud";
  risk: Risk;
  concurrency: "parallel_read" | "exclusive_mutation";
  requiresConnectedStudio?: boolean;
  inputSchema: unknown;
  preview?: (input: unknown) => Promise<ChangePreview>;
  execute: (input: unknown) => Promise<ToolResult>;
};
```

### Default Policies

| Capability | Default |
| --- | --- |
| Read tree, selection, properties, scripts, logs | Allow while connected |
| Toolbox search/details/thumbnails | Allow |
| Create harmless empty instances, edit scripts, set properties, insert reviewed asset | Ask once per proposed plan/change batch; allow user to approve one action or approved plan |
| Delete/move broad trees, bulk mutation, overwrite script, insert asset scripts | Always show impact and ask |
| `run_code`, playtest control, remotes tracing | Always ask initially; remember only narrow approved scopes |
| DataStore reads | Ask for universe/store/scope on first use; audit every read |
| DataStore writes/deletes/listing live player records | Always ask with environment, key, old/new preview, rollback limitations |
| Publishing/deployment/monetization | Out of MVP or always explicit approval |

## 7. Delivery Strategy

Build in vertical slices. The first useful beta does not need RAG, subagents, or autonomous playtests. It needs a trustworthy single-agent path that makes Studio changes through approval and makes Toolbox selection delightful.

### MVP Exit Criteria

- A signed-in user can pair one Studio session from the web app.
- The agent can inspect the place, ask questions, form a short plan, and wait for approval.
- "Build a Minecraft-style starter area" searches Toolbox, displays candidate asset thumbnails, prevents unsafe silent script insertion, inserts the chosen approved assets, and creates basic approved instances/scripts.
- Each mutation has an audit record and Studio undo boundary.
- Disconnection, denial, timeout, and bad asset results are surfaced correctly.

## 8. Phased Implementation Plan

## Phase 0: Baseline, Provenance, and Architecture Decision

**Objective:** Freeze a correct baseline and avoid building the hosted product around unsafe assumptions.

**Work**

- Document which current flows actually work end-to-end: connect plugin, read instance, create instance, ask user, Toolbox search, insert selected asset, undo.
- Add a simple capability matrix and record failures rather than relying on the older `implementation_plan.md`.
- Verify the provenance/license and reusable scope of `claude-code-opensource/`; decide whether to port concepts or permitted source modules.
- Write architecture decision records for server-owned agent runtime, MCP gateway direction, and credential boundaries.
- Identify current security blockers: unauthenticated session IDs, permissive CORS/proxy, browser-owned model execution, arbitrary `/code/run`, and Toolbox inserted scripts.

**Done when**

- Baseline test notes and architecture decisions exist.
- The team has a clear "reuse vs reimplement" decision for the Claude-derived source.
- No one treats UI scaffolding as completed secure functionality.

**Prompt for the implementation AI**

```text
Work on Phase 0 of /Users/sarthakkapila/stud/plan.md. Inspect the current React app, server/index.js, studio-plugin/stud-bridge.server.lua, src/lib/roblox, and claude-code-opensource. Produce repository docs for: (1) an end-to-end capability matrix with tested/not-tested/failed states, (2) security and hosting blockers, and (3) architecture decisions for server-owned runtime, MCP Studio gateway, and Claude-code reuse/provenance review. Do not implement new product features yet. Run any safe local validation available and cite exact source files in the docs.
```

## Phase 1: Server-Owned Agent Runtime and Event Stream

**Objective:** Move the authority for multi-turn execution out of React while keeping the current web UI.

**Work**

- Create a TypeScript server runtime package/module with conversation, run, event, tool-call, tool-result, interrupt, and approval-pending types.
- Port the useful `QueryEngine` behavior conceptually: persisted message history, bounded tool iterations, cancellation, structured tool results, model provider abstraction, and stream events.
- Introduce authenticated conversation/run endpoints and an SSE or WebSocket stream consumed by React.
- Move provider calls and future secrets server-side; temporarily preserve legacy browser path only behind a development flag while migrating.
- Persist run/transcript state with a development adapter first and a clean storage interface for database backing.
- Replace the UI's global `setAskUserHandler` dependency with run-scoped interaction events and responses.

**Done when**

- Refreshing/reconnecting the browser does not lose a running conversation state.
- Tool calls and approval requests stream from server runtime to the existing chat UI.
- A unit/integration test proves the server loop: model requests read tool -> result returned -> model gives final text.

**Prompt for the implementation AI**

```text
Implement Phase 1 from /Users/sarthakkapila/stud/plan.md. Keep the React UI styling, but create a server-owned TypeScript agent runtime with typed run events, persisted in-development conversation storage, cancellation, bounded iterations, and SSE or WebSocket streaming to the UI. Adapt the existing provider/tool-call behavior from src/lib/ai without exposing new secrets in the browser. Use claude-code-opensource/QueryEngine.ts and services/tools as reference patterns only after checking Phase 0 decisions. Add focused tests for multi-turn tool continuation, reconnection/event replay, and cancellation. Update docs with the new local run instructions.
```

## Phase 2: Roblox Studio MCP Gateway

**Objective:** Make Studio a proper connector surface underneath the agent instead of a growing set of browser-specific calls.

**Work**

- Define MCP tools for existing Studio operations: read tree/selection/script/properties, write/edit script, create/set/move/delete/clone/bulk instances, insert asset, and later diagnostics/playtests.
- Implement a server-side MCP gateway or adapter that maps MCP tool calls onto the existing session relay/plugin handler protocol.
- Namespace tools such as `mcp__roblox_studio__read_script` and retain typed structured results.
- Add tool call IDs, idempotency handling for mutations, timeout/cancellation semantics, heartbeat/presence, and compatibility with current polling plugin.
- Keep existing plugin endpoints working during migration; migrate the agent runtime to MCP tools rather than breaking the demo path first.
- Decide later whether the production plugin can maintain outbound WebSocket directly or needs a companion; HTTP polling remains a valid fallback.

**Done when**

- The server runtime can list and call Studio MCP tools for a paired session.
- Existing read/create/edit/undo flows operate through MCP.
- Retried mutation requests do not silently execute twice.

**Prompt for the implementation AI**

```text
Implement Phase 2 from /Users/sarthakkapila/stud/plan.md. Introduce a Roblox Studio MCP gateway on the server that exposes the currently supported plugin operations as typed, namespaced MCP tools and routes them through the existing session relay. Keep polling/plugin compatibility during migration. Add request IDs, heartbeat status, timeout/cancellation behavior, mutation idempotency, and integration tests with a mocked plugin poll/respond cycle. Switch the new server agent runtime to consume MCP tools rather than importing browser Roblox tool executors.
```

## Phase 3: Permission Engine, Plan Mode, and Audit Trail

**Objective:** Make the agent safe enough to mutate a real game.

**Work**

- Add tool metadata for read-only, mutation, destructive, runtime-code, secret, and Open Cloud operations.
- Create a policy engine that decides `allow`, `ask`, or `deny` before execution, independent of model instructions.
- Implement run-scoped web approval cards: action summary, affected paths, asset/script risk, allow once, allow approved plan, deny, and request modification.
- Implement plan mode: automatic reads allowed, mutations blocked, agent proposes structured steps/change scope, user approves before execution.
- Persist audit events for prompt, plan approval, permission decision, tool input summary, tool outcome, actor, project/session, and timestamps.
- Put `/code/run`, broad bulk changes, deletion, and script-bearing assets behind strong policy from day one.

**Done when**

- A model cannot bypass approval by directly calling a mutating tool.
- A denied action is reported back into the model loop as a structured denial.
- Approved plan execution permits only covered mutations; unexpected expansion pauses for another approval.

**Prompt for the implementation AI**

```text
Implement Phase 3 from /Users/sarthakkapila/stud/plan.md on the server runtime and React UI. Port the useful permission and plan-mode concepts from claude-code-opensource, adapted for Roblox paths and Studio/Open Cloud tools. Build enforced tool risk metadata, allow/ask/deny policy decisions, structured approvals, read-only plan mode, execution-scope checking, and durable audit events. Treat code execution, deletes, bulk changes, and script-bearing inserted assets as high risk. Add tests proving mutating MCP tools cannot execute without the required decision and that an approved plan cannot silently expand scope.
```

## Phase 4: Toolbox Asset Discovery Vertical Slice

**Objective:** Deliver the signature Lovable-for-Roblox experience safely.

**Work**

- Move Toolbox API calls behind the server runtime/gateway, retaining thumbnails and rich web selection UI.
- Support query expansion, pagination, deduplication, relevance/ranking signals, asset type filters, and "search again" / "let agent recommend" paths.
- On selection, retrieve metadata and inspect the inserted model or a safe preview for contained scripts and risky objects before accepting it into the target place.
- Provide a user decision: insert with scripts removed, review scripts before insert, approve as-is when allowed, or choose another asset.
- Record creator/asset ID/version and the user decision in the audit log.
- Test the target demo prompt end-to-end.

**Done when**

- The Minecraft-style prompt produces a visual selectable asset set and a safe approved insertion.
- Asset selection is a runtime interaction, not fabricated plain-text choices.
- Script-bearing or failed assets cannot silently alter the game.

**Prompt for the implementation AI**

```text
Implement Phase 4 from /Users/sarthakkapila/stud/plan.md. Build the production Toolbox vertical slice through the server agent runtime: searchable/paginated/deduplicated Creator Store results with thumbnails, interactive selection in the current React UI, approved insertion through Studio MCP, and an asset safety step for contained scripts or risky descendants. Preserve useful existing code in src/lib/roblox/toolbox.ts and QuestionPrompt where appropriate, but move trust decisions server-side. Add mocked API/MCP tests plus an end-to-end demo path for "make a Minecraft-style starter world."
```

## Phase 5: Robust Instance Manipulation and Live Studio Context

**Objective:** Make building complex scenes and code reliable instead of path-guessing.

**Work**

- Upgrade Studio tool results to return stable IDs/version data where possible, explicit changed paths, before/after summaries, errors, and undo transaction identifiers.
- Add optimistic conflict detection for script edits and property mutations.
- Wire `@instance` mentions into actual context collection instead of just inserting text.
- Inject a compact live context bundle per turn: Studio mode/connection, selected instances, relevant tree summary, requested scripts/properties, and recent errors.
- Show structured change history and meaningful diffs in the UI, reusing `DiffView`.
- Narrow or replace arbitrary `run_code` with typed tools wherever possible.

**Done when**

- The agent can change an existing game feature without guessing the target instance.
- Concurrent user edits cause a conflict prompt rather than being overwritten.
- The final response and UI show exactly what changed and how to undo it.

**Prompt for the implementation AI**

```text
Implement Phase 5 from /Users/sarthakkapila/stud/plan.md. Harden Studio manipulation over MCP with structured mutation results, transaction/undo identifiers, script revision conflict checking, actual @instance context resolution, and compact per-turn live Studio context injection. Reuse the existing InstancePicker, InstanceTree, and DiffView UI rather than rebuilding their visuals. Add tests for conflict detection, context construction, permission integration, and change display.
```

## Phase 6: DataStore and Open Cloud Tools

**Objective:** Let creators inspect and change game data without exposing credentials or risking silent production damage.

**Work**

- Implement server-only Roblox Open Cloud credential management with per-user/per-experience scopes and encrypted storage.
- Separate environments and make production visibly distinct from test/dev stores.
- Add DataStore tools for list stores/scopes, read key, list keys with limits, set/update key, increment where supported, and delete only if explicitly selected.
- Require approval for every write/delete, showing universe, store, scope, key, old value, proposed new value, and rollback limitations.
- Redact sensitive data in model context and audit output; apply record size, pagination, rate-limit, timeout, and retry controls.
- Never pass Open Cloud API keys to browser, plugin, tool output, or model text.

**Done when**

- An agent can answer "what is the test player's coin balance?" through an approved read flow.
- An update cannot run without a value preview and explicit approval.
- Credentials and sensitive records do not leak into chat or logs.

**Prompt for the implementation AI**

```text
Implement Phase 6 from /Users/sarthakkapila/stud/plan.md. Add a server-only Roblox Open Cloud DataStore gateway with secure credential storage interfaces, environment/scope selection, typed read/list/write/delete tools, permission enforcement, redacted audit events, and React approval/previews. Writes and deletes must always require explicit user approval showing old and new values. Add mocked Open Cloud tests for scopes, rate errors, redaction, denied writes, and approved updates. Do not put credentials in frontend state or Studio plugin traffic.
```

## Phase 7: Roblox Knowledge and Retrieval

**Objective:** Give the agent accurate Roblox and project-specific context without bloating every prompt.

**Work**

- Keep the system prompt short: Luau/Roblox execution model, server authority and security rules, tool/approval rules, and evidence hierarchy.
- Index live project scripts and metadata after connection or changes: instance path, class, server/client side, symbols/services/remotes, revision, and source.
- Add official Roblox documentation retrieval for APIs used by the task.
- Only later add curated example games/corpus, with provenance and quality filters.
- Use hybrid keyword/vector retrieval and labeled context blocks ordered as live project, project index, official docs, approved examples.
- Rebuild live context after mutations and after compaction.

**Done when**

- The agent cites/uses the correct live script and correct server/client boundary for representative tasks.
- Retrieval has budget controls and does not dump the entire knowledge base into prompts.

**Prompt for the implementation AI**

```text
Implement Phase 7 from /Users/sarthakkapila/stud/plan.md using the guidance in knowledge-base/ROBLOX_RAG_PIPELINE.md, ROBLOX_CORPUS_INDEXING.md, and ROBLOX_SYSTEM_PROMPT_CONTEXT_INJECTION.md. Build a compact Roblox system prompt, live Studio script index with metadata/revisions, official documentation retrieval, labeled budgeted context injection, and reindexing after mutations. Begin with live project plus official docs; do not ingest a broad example-game corpus until provenance and quality filtering are implemented. Test retrieval ranking and server/client correctness on sample Luau tasks.
```

## Phase 8: Subagent Delegation

**Objective:** Allow larger tasks to be researched in parallel without multiplying mutation risk.

**Work**

- Add parent-owned task records, child contexts, budgets, cancellation, progress events, and result summaries.
- Begin with read-only specialist agents: world planner, Luau reviewer/debugger, UI designer, asset researcher, and security reviewer.
- Let subagents use read-only Studio MCP and retrieval tools by default.
- Route any proposed mutation back to the parent agent for plan inclusion and user approval; do not let background subagents mutate a live Studio place independently in MVP.
- Add limits for number of subagents, tool calls, tokens/cost, wall-clock time, and shared context size.

**Done when**

- A complex prompt can delegate bounded research and merge recommendations into one approved execution plan.
- Cancellation stops child work and no child bypasses permission policy.

**Prompt for the implementation AI**

```text
Implement Phase 8 from /Users/sarthakkapila/stud/plan.md. Adapt the subagent concepts in claude-code-opensource/tools/AgentTool and tasks into the server runtime. Start with read-only Roblox specialist agents with isolated context, budgets, progress/cancellation, and parent-visible summaries. Subagent mutation requests must be converted into parent plan proposals and pass the existing permission engine. Add tests for isolation, cancellation, bounded concurrency, and mutation denial.
```

## Phase 9: Playtest, Observe, and Fix Loop

**Objective:** Let the agent verify gameplay changes with evidence from Studio.

**Work**

- Extend the plugin/MCP surface with Studio mode, run/stop playtest, server/client logs, diagnostics, error grouping, and optional screenshots later.
- Capture a baseline before modifications and distinguish new errors from pre-existing noise.
- Represent verification as structured records containing changed instances/scripts, errors, assertions, timeouts, attribution, and confidence.
- Add controlled iteration: initial playtest plus at most three fix attempts by default; stop on no progress, disconnection, ambiguity, expanded risk, or budget exhaustion.
- Require approval for playtest execution according to policy and for any new risky fix outside the approved plan.

**Done when**

- For a scripted game feature, Stud can make an approved change, run a playtest, identify attributable new errors, fix within permission scope, rerun, and report evidence.

**Prompt for the implementation AI**

```text
Implement Phase 9 from /Users/sarthakkapila/stud/plan.md using knowledge-base/ROBLOX_AGENT_PRODUCT_ARCHITECTURE_DOC.md. Add typed Studio MCP tools for playtest lifecycle, log/diagnostic capture, structured baseline comparison, and a bounded observe-fix loop in the agent runtime. Respect permission scope and stop conditions; logs are untrusted data, never instructions. Build mocked Studio tests for pass, new error, timeout, disconnect, no-progress stopping, and a successful single-fix rerun.
```

## Phase 10: Hosted Product Hardening and Beta

**Objective:** Run Stud safely for real creators and multiple projects.

**Work**

- Add authentication, organizations/projects/experiences, secure plugin pairing tokens, token expiry/revocation, and tenant isolation.
- Move persistence to durable database/object storage and deploy worker/job infrastructure for runs and subagents.
- Add resumable client event streams, reconnect behavior, rate limits, observability, cost controls, and incident/audit tooling.
- Harden relay security: origin rules, CSRF/auth, proxy allowlists, message validation, size limits, replay protection, secret redaction, and abuse protections.
- Add onboarding, permission settings, exportable change/audit history, feedback capture, and staged rollout.

**Done when**

- Multi-user beta sessions cannot cross-read or cross-mutate projects.
- Interrupted sessions recover safely and every high-risk action is attributable.

**Prompt for the implementation AI**

```text
Implement Phase 10 from /Users/sarthakkapila/stud/plan.md as a production hardening effort. Add authenticated multi-tenant project/session models, secure expiring Studio pairing, durable conversations/audit history, resumable run streaming, worker/job execution, rate/cost controls, redaction and relay security, plus deployment documentation. Use threat-model-driven tests proving tenant isolation and replay/authorization protection. Preserve the approved single-user Studio workflow while upgrading its backing services.
```

## 9. Suggested Build Order and Dependencies

| Order | Phase | Depends on | Why now |
| --- | --- | --- | --- |
| 1 | Phase 0 | Current repository | Avoid committing to an unsafe or unusable base |
| 2 | Phase 1 | Phase 0 decisions | All later enforcement belongs in server runtime |
| 3 | Phase 2 | Phase 1 | Provides one connector contract for Studio |
| 4 | Phase 3 | Phases 1-2 | Mutations must be governed before new power is added |
| 5 | Phase 4 | Phase 3 | Ships the differentiating asset-building beta path |
| 6 | Phase 5 | Phases 2-3 | Makes real project edits trustworthy |
| 7 | Phase 6 | Phase 3 | Adds sensitive Cloud capability only after policy exists |
| 8 | Phase 7 | Phase 5 | Retrieval becomes useful after live state is dependable |
| 9 | Phase 8 | Phases 1, 3, 7 | Delegation needs stable context and authority boundaries |
| 10 | Phase 9 | Phases 2, 3, 5 | Verification needs reliable Studio actions and policy |
| 11 | Phase 10 | All beta essentials | Production hosting hardening and rollout |

## 10. Initial Backlog for the First Beta

### Must Have

- Server-owned agent loop and streaming UI integration.
- Authenticated paired Studio session and typed MCP gateway.
- Permission enforcement, approval UI, plan mode, and audit events.
- Safe Toolbox search/choose/insert flow with asset script review.
- Reliable instance/script change results, diff display, and undo reporting.

### Should Have

- Live tree/selection/script context injection.
- A small official-doc lookup path for Roblox APIs.
- Basic playtest/log verification for scripted changes.

### Later

- Production DataStore writes.
- Broad external Roblox corpus.
- Autonomous mutation-capable subagents.
- Publishing, monetization, generated audio/images/models, or marketplace systems.

## 11. Risks To Keep Visible

| Risk | Mitigation |
| --- | --- |
| Imported agent source cannot legally or technically be reused directly | Phase 0 provenance/license/buildability decision; port architecture concepts if necessary |
| Browser execution exposes policy or credentials | Server-owned runtime before sensitive capabilities |
| Toolbox models contain malicious scripts | Inspect, warn, strip/review/approve policy before insertion |
| Arbitrary Luau execution can destroy place state | High-risk permission gate; replace with typed tools; transactions and audit |
| DataStore mistakes harm player data | Server-only scoped credentials, environment separation, write previews, explicit approval |
| Custom bridge expands without protocol discipline | MCP gateway, typed schemas, IDs, idempotency, cancellation |
| Agent claims success without game behavior evidence | Add structured playtest loop after mutation foundation |
| Huge knowledge base worsens quality/cost | Retrieve only high-authority relevant context with budgets |

## 12. Definition of the Product Direction

Do not rebuild Claude Code's terminal product in a browser and then bolt Roblox onto it. Build Stud as a Roblox-native web agent:

- its runtime borrows mature agent-loop, permission, MCP, compaction, and delegation ideas;
- its primary workspace is a live Roblox Studio place, not a filesystem;
- its most important interaction is safe visual construction through Studio and Creator Store assets;
- its safety model treats game mutations and player data as real user assets requiring evidence and consent.

That path gets to a compelling beta quickly while leaving room for the larger vision: an agent that can actually build, reason about, test, and maintain Roblox games.
