# Phase 3 Permission, Plan Mode, and Audit

Date: 2026-05-25

## Enforcement

Permission enforcement lives in the server execution path, not in model prompts or React:

| Concern | Server implementation |
| --- | --- |
| Tool risk metadata | `server/agent/types.ts` and `server/agent/tools.ts` attach `risk`, `transport`, `concurrency`, and an execution `scope` to every tool. |
| Allow/ask/deny | `server/agent/policy.ts` automatically allows reads, denies mutation calls in plan mode, and asks for new execution scopes. |
| Structured approval pause | `server/agent/runtime.ts` emits `approval_pending` before execution and waits for authenticated decisions through `server/agent/routes.ts`. |
| React approvals | `src/components/chat/ApprovalPrompt.tsx`, wired in `src/pages/Home.tsx`, presents allow once, narrow scope approval, deny, and script-stripped insertion. |
| Read-only plan mode | The existing Plan chip submits `mode: "plan"` in `src/pages/Home.tsx`; policy refuses any requested mutation and emits `plan_proposed`. |
| Durable audit | Persisted conversations contain `auditEvents` for prompts, tool requests, policy decisions, user approvals, outcomes, and proposed plans in `server/agent/store.ts`. |
| Conversation authorization | `POST /agent/conversations` returns a random conversation token; subsequent transcript/run/SSE/decision endpoints require its hash match in `server/agent/routes.ts`. |
| Relay bypass prevention | Mutating `/stud/.../request` paths in `server/index.js` require the internal gateway token set only on server-originated calls. |

## Risk Defaults

| Tools | Risk | Behavior |
| --- | --- | --- |
| Studio reads, server Toolbox search, questions | `read` | Allowed. |
| Script edits, instance creation, single property changes, clone | `low_mutation` | Requires approval until that exact scope is approved. |
| Delete, move, bulk mutations | `destructive` | Requires explicit approval; UI does not offer remembered high-risk scope approval. |
| `mcp__roblox_studio__execute_luau` | `runtime_code` | Requires explicit approval for each request shown in the UI. |
| Creator Store insert | `external_asset` | Runs detached asset inspection before approval; scripts trigger a visible remove-scripts choice. |

An approved scope is an exact `(tool name, intended change scope)` pair. Script/property scope includes a change fingerprint/value, and instance creation includes target and class. Approval for `game.Workspace/Allowed:Part` does not authorize `game.Workspace/Expanded:Part` or a different approved-path edit.

## Validation

`server/agent/permissions.test.ts` proves a mutating MCP tool is not invoked before a decision, that a second unexpected target creates another approval pause, and that plan mode returns structured denial without executing a mutation. `server/agent/toolbox.test.ts` proves script-stripped insertion is passed to Studio only after the corresponding approval.

This is development authorization and auditing. Hosted deployment still needs real user identity, project/session ownership, secure persistent storage, rate limiting, origin/CSRF policy, and audit retention controls.
