# Phase 0 Security and Hosting Blockers

Date: 2026-05-25

This document records blockers found while moving Stud from a local prototype toward a hosted Roblox-building agent. It is not a claim that the local prototype is compromised; it identifies boundaries that are not adequate for multi-user deployment or sensitive game changes.

## Critical Blockers

| Blocker | Current evidence | Impact | Required disposition |
| --- | --- | --- | --- |
| Studio sessions are capability codes without identity or authorization | `src/lib/bridge/session.ts` creates a browser-local eight-character code; `server/index.js` accepts any matching `:sessionId` and creates an in-memory session automatically. | Anyone who obtains/guesses a valid live code can submit commands to that Studio connection; sessions cannot be associated reliably with a user or project. | Introduce authenticated user/project sessions, expiring pairing tokens, authorization on web and plugin channels, revocation, and audit ownership before hosted beta. |
| Game mutations are not policy-enforced | Tools in `src/lib/roblox/tools.ts` execute bridge calls directly; plugin mutation handlers in `studio-plugin/stud-bridge.server.lua` run once received. | A model call can alter/delete live game content without a server-side permission decision. | Phase 3 permission engine must sit before every mutating connector call. |
| Arbitrary Luau evaluation is model-callable | `roblox_run_code` calls `/code/run`; plugin handler compiles and runs supplied source through `loadstring`. | Arbitrary project mutation and potentially destructive actions can be performed without narrow tool constraints. | Mark as high-risk, require explicit approval, audit invocation, and replace common tasks with typed tools. |
| Toolbox asset contents are inserted without safety inspection | `roblox_insert_asset` and plugin `/asset/insert` load and parent the returned asset directly. | Free models can introduce executable scripts or unwanted descendants into a creator's game. | Add pre-insert inspection/quarantine and user policy for stripping, reviewing, approving, or rejecting scripts. |

## High Priority Hosting Blockers

| Blocker | Current evidence | Impact | Planned treatment |
| --- | --- | --- | --- |
| Agent execution and API-key settings are browser-owned | `src/lib/ai/providers.ts` starts AI SDK tool loops in React; `src/stores/settings.ts` persists provider keys in browser storage; `src/lib/auth/codex.ts` persists Codex OAuth tokens locally. | A hosted UI cannot centrally govern runs, permissions, secrets, audit, cancellation, or durable recovery. | Phase 1 moves new run execution server-side. Existing browser key transport remains development compatibility debt until secure server credential setup is added. |
| OAuth callback is global and not session-isolated on the bridge | `server/index.js` stores one process-wide `oauthCallback` and serves it from `/auth/poll`. | Concurrent users can collide or receive the wrong pending callback in a hosted deployment. | Replace with authenticated state-bound callback storage before multi-user use. |
| Permissive CORS and unauthenticated proxy routes | `server/index.js` calls `cors({ origin: true })`, exposes bridge status/requests, Codex forwarding, and whitelisted external GET proxy without user auth. | Hosted endpoint can be abused as a relay and exposes control surfaces cross-origin. | Require authenticated origins/session authorization and restrict forwarding; apply CSRF/rate/size controls. |
| Relay state is in process memory only | `sessions` in `server/index.js` is a module `Map`; pending actions and presence vanish on restart. | No durable runs, replay, failover, audit, or safe recovery after a server restart. | Phase 1 persists conversation/run events for development; production durable queue/session persistence belongs in hosting hardening. |
| Request relay lacks mutation idempotency | `nextRequestId()` allocates request IDs, but plugin calls are not recorded as applied transactions for retry deduplication. | A retry/reconnect can duplicate a mutation once transport evolves beyond the simple current request wait. | MCP/connector phase must carry operation IDs and plugin-side transaction result deduplication. |

## Medium Priority Safety and Correctness Issues

| Issue | Evidence | Consequence | Treatment |
| --- | --- | --- | --- |
| Tool timeout does not prove whether a mutation executed | `src/lib/roblox/client.ts` and `server/index.js` time out after 15 seconds while plugin may have already acted. | User/agent cannot safely retry an unknown-result mutation. | Idempotency and explicit operation state in connector protocol. |
| Script editing has no revision conflict check | `/script/edit` in `studio-plugin/stud-bridge.server.lua` replaces matching text from current source with no expected revision. | User edits can be overwritten or edits can target unintended current content. | Add revision/hash preconditions and conflict UI. |
| Property parser is permissive and ambiguous | Plugin `/instance/set` and bulk set infer value types from strings. | Wrong property values can be silently chosen for vectors/colors/numbers. | Typed MCP schemas and plugin validation. |
| Audit is visual-only and transient | Plugin activity list is held in memory; UI tool calls are chat state only. | No durable accountable record of who approved and what changed. | Persist audit/run events server-side; later tenant storage. |
| Proxy allowlist does not include the economy endpoint used for details | `src/lib/roblox/toolbox.ts` uses `https://economy.roblox.com/`; `src/lib/http.ts` proxies only selected Roblox domains and fetches others directly. | Toolbox details may fail in browser due to CORS despite search working. | Move Toolbox access server-side in Phase 4 and keep one tested server allowlist. |

## Secret and Data Boundary

These rules apply immediately to new server runtime work:

1. Do not add DataStore/Open Cloud credentials to frontend stores, URL parameters, Studio plugin traffic, model messages, or streamed run events.
2. Do not persist provider credentials in development transcript files.
3. Phase 1 may accept existing browser-configured provider tokens only as a temporary local-development input; documentation and code must make this debt visible.
4. Server environment variables should be supported for Anthropic/OpenRouter local execution so the browser need not receive those keys.
5. Treat Roblox place state, scripts, output logs, and Toolbox model contents as untrusted data returned from connector tools, not instructions.

## Blockers vs Phase Scope

| Blocker category | Phase addressing it |
| --- | --- |
| Browser-owned loop, no durable events/replay/cancellation | Phase 1 |
| Custom Studio relay not MCP/idempotent | Phase 2 |
| No enforced approvals/audit | Phase 3 |
| Unsafe asset insertion | Phase 4 |
| Script conflict/context correctness | Phase 5 |
| Sensitive DataStore access | Phase 6 |
| Multi-user auth, durable queues, secure pairing and proxy hardening | Phase 10, with interfaces established earlier |

## Roblox MCP Reference Note

The added `studio-rust-mcp-server/` reference implementation is MIT-licensed and confirms that Studio can be operated through MCP tools, but it does not remove Stud's policy responsibilities. Its tools include arbitrary `run_code` and model insertion, both of which remain high-risk for an autonomous agent. Its `README.md` also points to Roblox Studio's newer built-in MCP server as the recommended connector. Stud must wrap either connector with authentication, permissions, audit, safe asset handling, and tenant boundaries.
