# Corpus — Roadmap, Fix Prompts & Claude Code Integration

Everything in one place: what to fix right now, prompts to do it, and how to pull every
useful pattern from `claude-code/` into the Roblox agent.

---

## Part 1 — What's broken / incomplete right now

Ranked by what blocks shipping vs. what is polish.

### 1. Scope approval is too strict — agent keeps asking for the same permission

`approve-scope` does exact `tool+scope` string matching. Approving "write
`game.ServerScriptService.Main`" does not carry over to any other path, so the agent asks
again on every new script. `policy.ts` already has a `fullAccess` flag and the routes accept
it, but there is no UI button to enable it.

**Quick win:** wire the existing `fullAccess` field into a toggle button in the composer or
settings — one line in the policy already auto-approves all mutations when it is set.

---

### 2. Mutation diff rendering is half-done

`src/components/chat/structured-diff.ts` has a complete word-level diff algorithm with
hunks, line numbers, and word ranges. It is completely unused. `MutationDiff.tsx` and
`tool-call.tsx` still render raw before/after strings. The good work is sitting idle.

**Quick win:** call `buildStructuredDiff()` from `structured-diff.ts` inside `MutationDiff.tsx`
and render the `StructuredDiffHunk[]` output instead of raw text.

---

### 3. Corpus has zero data

The retrieval infrastructure is complete. Vectorize indexes are empty. Every corpus
code path silently returns nothing until you run the pipeline. See Part 2 for the full
fix — there are also two code bugs (intent gate too narrow, missing general index) on top
of the data gap.

---

### 4. Production is not ready

`.env` has `CORPUS_ALLOW_ANONYMOUS=true` and `NODE_ENV=development`. Anonymous mode bypasses
auth entirely. Before going live: set `CORPUS_ALLOW_ANONYMOUS=false`, `NODE_ENV=production`,
`CORPUS_COOKIE_SECURE=true`, and point Google OAuth redirect URI at the real domain.

---

### 5. Login/logout UX is incomplete

Logout works (it lives in SettingsDialog) but there is no user avatar or "signed in as"
in the main header, and no redirect back to the login screen after logout fires. The
LoginScreen has no error-recovery path if the email token fails.

---

### Priority table

| # | What | Effort | Impact |
|---|------|--------|--------|
| 1 | Wire `structured-diff.ts` into diff UI | Small | High — every script edit looks better |
| 2 | Full-access mode toggle in UI | Small | High — kills repeated approval prompts |
| 3 | Broader scope approval matching | Medium | High — fewer interrupts in long runs |
| 4 | Login/logout UX polish | Small | Medium — required before real users see it |
| 5 | Production env + deploy | Ops | Blocker for going live |
| 6 | Corpus data pipeline | Ops | Required for corpus to do anything |
| 7 | Claude Code integrations (Part 3) | Large | Future quality improvements |

---

## Part 2 — Corpus / Embeddings Fix Prompts

Three code bugs plus one ops gap. Fix them in order.

---

### Fix 1 — Intent gate is too narrow (most queries silently skipped)

**File:** `server/agent/corpus/retrieve.ts`

`shouldUseCorpus()` only matches explicit Roblox API names like `serverscriptservice`,
`remoteevent`, `humanoid`. Everyday queries like "create a health system", "add coins",
"make a gun", "build a shop GUI" never trigger retrieval.

**Prompt:**

```
In server/agent/corpus/retrieve.ts, the GAME_TERMS_RE regex in shouldUseCorpus() is too
narrow — it only matches explicit Roblox API names so most real user queries never reach
corpus retrieval.

Expand GAME_TERMS_RE to also match common Roblox game-dev vocabulary. Add these groups:

Game mechanics:
  health|damage|kill|die|respawn|revive|coins?|gems?|cash|currency|money|shop|store|
  buy|sell|purchase|inventory|item|weapon|gun|sword|tool|ability|skill|power|boost|
  speed|jump|stamina|sprint|dash|dodge|attack|defend|shield|armor|loot|drop|pickup

Scripting concepts:
  script|function|module|bind|connect|event|fire|invoke|signal|loop|timer|
  wait|delay|debounce|cooldown|trigger|detect|hit|touch|overlap|raycast|
  region3|cframe|vector3|tween|lerp|animate|track|weld|constraint|joint

World / UI:
  gui|button|label|frame|screen|menu|hud|popup|dialog|prompt|notification|
  billboard|surface|part|model|mesh|union|texture|decal|particle|effect|
  sound|music|ambient|light|shadow|fog|sky|terrain|water|baseplate|
  workspace|folder|value|attribute

Player systems:
  leaderboard|stats|points|score|rank|level|xp|exp|badge|gamepass|
  pass|product|vip|team|group|spectator|spawn|respawn|kill|death

Keep all existing terms. Add these to the same alternation. Do not change any other logic.
```

---

### Fix 2 — `roblox-general` index never exists so low-confidence queries always return 0

**File:** `server/agent/corpus/retrieve.ts`

When no niche is detected (or confidence < 2) the code searches `${prefix}-general`
(i.e. `roblox-general`). But `embed-games.ts` only creates `${prefix}-${game.niche}`
indexes. There is never a `roblox-general` index. Cloudflare errors are caught and silently
return empty so this fails invisibly.

**Prompt:**

```
In server/agent/corpus/retrieve.ts, retrieveCorpusContext searches `${prefix}-general`
as a fallback but embed-games.ts never creates that index, so it always returns empty.

Fix: when no strong niche is detected (confidence < 2), search ALL niche indexes in
parallel instead of one non-existent general index.

Changes:
1. Add at the top: const ALL_NICHES = Object.keys(NICHE_KEYWORDS)
2. In retrieveCorpusContext, replace the `${prefix}-general` search with:
   ALL_NICHES.map(n => searchIndex(`${prefix}-${n}`, 4)) — run them all in parallel.
3. When a strong niche IS detected (confidence >= 2), keep current behaviour:
   search only `${prefix}-${niche}` with topK=12.
4. Deduplication and scoring already happen after the searches — rest stays the same.

Do not change any other logic.
```

---

### Fix 3 — Score threshold may filter everything in sparse indexes

**File:** `server/agent/corpus/config.ts`

Default `CORPUS_MIN_SCORE=0.70` is high for new or lightly-populated indexes.

**Prompt:**

```
In server/agent/corpus/config.ts, change the DEFAULT_MIN_SCORE constant from 0.70 to 0.50.

Also in server/agent/corpus/retrieve.ts, after the `if (bestScore < config.minScore)` check,
add a log line that shows what was filtered:
  [corpus:retrieve] score gate filtered: best=${bestScore.toFixed(4)} threshold=${config.minScore.toFixed(4)} top3=[${deduped.slice(0,3).map(r=>r.score.toFixed(4)).join(', ')}]

This lets us calibrate the threshold from real query data.
```

---

### Fix 4 — No data in Vectorize (indexes are empty)

This is an ops problem, not a code problem.

Check status first:
```bash
curl http://localhost:3001/corpus/status
```

If `pendingGames: 0` and you haven't ingested anything, every retrieval call returns empty
regardless of the code fixes above.

**Steps to populate:**
```bash
# 1. Convert .rbxl files → .lua scripts
bun run scripts/batch-convert.ts

# 2. Upload to R2 + register in Postgres
bun run scripts/sync-corpus.ts

# 3. Embed + push to Vectorize
bun run scripts/embed-games.ts --games=all

# 4. Verify
curl http://localhost:3001/corpus/status
```

**Diagnostic endpoint prompt (optional):**
```
Add GET /corpus/debug in server/index.js that calls retrieveCorpusContext with the test
query "tycoon dropper income system" and returns the full result object plus corpus config
ready/missing state. No auth required. Localhost only is fine.
```

---

### Verification (run after all fixes + data ingested)

```
Set CORPUS_LOG_RETRIEVAL=true, restart the bridge, start an agent run with:
"help me build a tycoon dropper system"

In the server console you should see:
  [corpus:retrieve] query="..." detectedNiche=tycoon
  [corpus:retrieve] Vectorize returned N match(es) from roblox-tycoon
  [rag] injecting N corpus chunk(s)

If you still see "skipped by intent gate" — Fix 1 was not applied.
If Vectorize returns 0 — Fix 2 or Fix 4 is the blocker.
```

---

## Part 3 — Claude Code Integration Prompts

Everything in `claude-code/` that maps onto Corpus. One section per feature, each with a
self-contained prompt. Read the source path listed before pasting the prompt.

**Master prompt — paste this first in every session:**

```
You are implementing features from Claude Code (the reference at claude-code/) into Corpus,
a Roblox Studio AI agent. Server lives in server/agent/, frontend in src/. Read CODEBASE.md
before starting. Follow every convention in CLAUDE.md.
When I say "implement X from claude-code/", read the reference source, understand the
pattern, then adapt it to Corpus's architecture (Express + TypeScript server, React + Zustand
frontend, Roblox Studio plugin bridge). Never copy-paste wholesale — adapt.
```

---

### CC-1 — Color Diff for Script Mutations

**Source:** `claude-code/native-ts/color-diff/index.ts`

Word-level and line-level diff with color highlighting. Corpus already has `structured-diff.ts`
with hunks and line numbers but `MutationDiff.tsx` still renders raw before/after strings.

**Prompt:**
```
Read claude-code/native-ts/color-diff/index.ts and src/components/chat/structured-diff.ts.

structured-diff.ts already has buildStructuredDiff() with full hunk + word-range output but
MutationDiff.tsx and tool-call.tsx are not using it. Wire it up:

1. In src/components/chat/MutationDiff.tsx, call buildStructuredDiff({ beforeSource, afterSource,
   path, language: "luau" }) and render the resulting hunks[] instead of raw strings.
   - Removed lines: red left border + faint red background
   - Added lines: green left border + faint green background
   - Line numbers in a left gutter
   - Collapse if diff > 20 lines: show first 10 + "N more lines" expander button

2. In src/components/ui/tool-call.tsx, for edit_script results that have beforeSource and
   afterSource, use the word-level wordRanges from StructuredDiffLine to highlight changed
   words inline (not just line-level).

3. Use Tailwind classes that match the existing corpus-panel/corpus-soft color tokens.

Do not create any new files. Only update MutationDiff.tsx and tool-call.tsx.
```

---

### CC-2 — Full-Access Mode Toggle

**Source:** `claude-code/tools/BypassPermissionsModeDialog.tsx` (concept only — adapt)

`fullAccess` flag already exists end-to-end in `policy.ts`, `types.ts`, `routes.ts`, and
`settings.ts`. There is no UI to enable it.

**Prompt:**
```
In Corpus, fullAccess mode already exists in the backend (policy.ts auto-approves all
mutations when run.fullAccess is true) and in src/stores/settings.ts (fullAccess: boolean).
But there is no UI to toggle it.

1. In src/pages/Home.tsx, in the composerActions block, add a small shield icon button
   next to the ModelSelector. When fullAccess is true, show it in red/warning color with
   tooltip "Full access ON — all mutations auto-approved". When false, show it greyed out.
   On click, toggle useSettingsStore().fullAccess.

2. In src/lib/ai/server-agent.ts in sendServerMessage(), pass fullAccess from the settings
   store in the run request body.

3. In src/pages/Home.tsx, show a dismissible warning banner at the top of the chat when
   fullAccess is true: "Full access mode is on. The agent will not ask for approval before
   making changes."

That is all. The backend already handles everything else.
```

---

### CC-3 — Multi-Agent Spawning (Subagents)

**Source:** `claude-code/tools/AgentTool/runAgent.ts`,
`claude-code/tools/AgentTool/built-in/`

Claude Code spawns focused specialist agents with scoped tools and handoff prompts. Corpus's
`subagent.ts` exists but is a thin wrapper without proper isolation.

**Prompt:**
```
Read claude-code/tools/AgentTool/runAgent.ts and claude-code/tools/AgentTool/built-in/
(all 5 files: claudeCodeGuideAgent.ts, exploreAgent.ts, generalPurposeAgent.ts,
planAgent.ts, verificationAgent.ts).

Refactor server/agent/subagent.ts to match Claude Code's subagent pattern:

1. Define SubagentSpec: { type: string; systemPrompt: string; allowedTools: string[]; maxIterations: number }

2. Implement 5 built-in specialists adapted for Roblox:
   - explore: reads hierarchy, scripts, properties — no mutations
   - plan: read-only, outputs structured step JSON
   - debugger: reads scripts, runs diagnostic Luau, never writes
   - ui_specialist: reads/writes ScreenGui, Frame, TextLabel, ImageLabel only
   - network_specialist: reads/writes RemoteEvent, RemoteFunction, server scripts only

3. Each subagent runs a full AgentRuntime.execute() loop with its own AbortController
   linked to the parent run's signal (parent cancel = child cancel immediately).

4. Progress events from the child forward to the parent via emitSubagentProgress() with
   subagentType set to the specialist name.

5. Subagent tool result is: full text output for explore/plan/debug, or list of mutations
   performed for ui_specialist/network_specialist.

Keep existing tool registration in tools.ts.
```

---

### CC-4 — Plan Mode with Structured Steps

**Source:** `claude-code/tools/EnterPlanModeTool/`,
`claude-code/tools/ExitPlanModeTool/`

Corpus has plan mode but it outputs free text. Claude Code uses structured step objects that
map directly to UI affordances.

**Prompt:**
```
Read claude-code/tools/EnterPlanModeTool/ and claude-code/tools/ExitPlanModeTool/.

Improve Corpus's plan mode in server/agent/plan.ts:

1. Change plan output from free text to a structured Zod-validated JSON schema:
   {
     planId: string,
     summary: string,
     steps: [{
       index: number,
       title: string,
       description: string,
       toolNames: string[],
       risk: "read" | "low_mutation" | "destructive",
       scope: string,
       estimatedChanges: number
     }]
   }

2. The submit_plan tool validates this with Zod before accepting.

3. Add src/components/chat/PlanStepList.tsx: renders steps as a checklist. Steps turn
   green with a checkmark as consumedStepIndices grows (already tracked in the store).

4. In Home.tsx, when plan_steps_proposed arrives, show PlanStepList inline above the
   approval buttons.

5. Approved plan steps pre-authorize their toolNames so those tools skip the approval
   prompt during execution.

Do not change the ApprovalPrompt flow for non-plan runs.
```

---

### CC-5 — Session Memory

**Source:** `claude-code/services/SessionMemory/sessionMemory.ts`,
`claude-code/services/extractMemories/extractMemories.ts`,
`claude-code/services/extractMemories/prompts.ts`

After each run, extract facts worth remembering and inject them into future runs.

**Prompt:**
```
Read claude-code/services/SessionMemory/sessionMemory.ts,
claude-code/services/extractMemories/extractMemories.ts,
and claude-code/services/extractMemories/prompts.ts.

Add session memory to Corpus:

1. Add server/agent/memory.ts:
   - extractMemories(messages, runText, signal): calls the LLM with a short extraction
     prompt asking for JSON: [{ key: string; value: string; category: "project"|"preference"|"pattern" }]
   - storeMemories(conversationId, facts): upsert into new Postgres table agent_memories
     (conversationId, key, value, category, createdAt)
   - loadMemories(conversationId): fetch 10 most recent for this conversation

2. In server/agent/system-prompt.ts add injectMemories(memories): appends to the system
   prompt as:
   <corpus_memory>
   [project] This game uses DataStore v2 with retry wrappers.
   [pattern] User prefers ModuleScript over Script for shared logic.
   </corpus_memory>

3. In runtime.ts execute() iteration 1: call loadMemories() alongside buildRagContext().

4. After run_completed is emitted: call extractMemories() in a non-blocking void background
   call — never await it in the main loop.

5. Add agent_memories to prisma/schema.prisma and run a migration.
```

---

### CC-6 — Task Tracking

**Source:** `claude-code/tools/TaskCreateTool/TaskCreateTool.ts`,
`claude-code/tasks/types.ts`

The agent creates structured tasks and updates them as work progresses. Users see a live
checklist during long runs.

**Prompt:**
```
Read claude-code/tools/TaskCreateTool/TaskCreateTool.ts and claude-code/tasks/types.ts.

Add task tracking to Corpus:

1. Add three tools to server/agent/tools.ts:
   - corpus_task_create: { title, description? } → returns taskId
   - corpus_task_update: { taskId, status: "pending"|"in_progress"|"completed"|"blocked", note? }
   - corpus_task_list: no args → returns task list for this run

2. Tasks live in ActiveRun.tasks: Map<string, Task> — no DB persistence needed.

3. Emit SSE event type "task_update" on create/update:
   { type: "task_update", taskId, title, status, note?, runId }

4. Add task_update to AgentEventData in types.ts.

5. In server-agent.ts handle task_update and call callbacks.onTaskUpdate(task).

6. Add src/components/chat/TaskProgress.tsx: compact checklist with status icons.
   Show it in Home.tsx during streaming, above the streaming loader.

7. In system-prompt.ts tell the model to use corpus_task_create at the start of complex
   multi-step operations and corpus_task_update as each step completes.
```

---

### CC-7 — Auto-Compact (Context Window Management)

**Source:** `claude-code/services/compact/compact.ts`,
`claude-code/services/compact/prompt.ts`

Summarizes old turns when approaching the context limit so long runs don't fail.

**Prompt:**
```
Read claude-code/services/compact/compact.ts and claude-code/services/compact/prompt.ts.

Add context auto-compaction to Corpus:

1. Add server/agent/compact.ts:
   - estimateTokens(messages): sum of char counts / 4
   - needsCompaction(messages, maxTokens): true when estimate > 0.75 * maxTokens
   - compactMessages(messages, signal): calls the LLM with the compact prompt from
     claude-code/services/compact/prompt.ts adapted for Roblox context.
     Returns new messages array where turns older than last 8 are replaced with one
     assistant summary message.

2. In runtime.ts execute() at the start of each iteration after iteration 1:
   check needsCompaction(conversation.messages). If true, compact and log:
   [agent] compacted N → M messages

3. maxTokens per tier in ai-config.ts: free=40k, pro=80k, hyper=150k, super=200k

4. Emit SSE event "context_compacted": { type, before, after, iteration }

5. In Home.tsx show a subtle inline notice "Context compacted (N→M msgs)" when this
   event arrives.
```

---

### CC-8 — Prompt Suggestions

**Source:** `claude-code/services/PromptSuggestion/promptSuggestion.ts`,
`claude-code/services/PromptSuggestion/speculation.ts`

Speculatively generates 3 follow-up suggestions after each run based on what just happened.

**Prompt:**
```
Read claude-code/services/PromptSuggestion/promptSuggestion.ts and speculation.ts.

Replace the static SUGGESTIONS array in Home.tsx with dynamic post-run suggestions:

1. Add server/agent/suggestions.ts:
   generateSuggestions(lastText, toolNames, signal): Promise<string[]>
   Calls the LLM (free tier) with:
   "Based on this Roblox Studio agent response, suggest 3 short follow-up actions.
    Output as JSON array of strings. Max 8 words each. Roblox context."
   Returns 3 strings or [] on error.

2. Add POST /agent/conversations/:id/suggestions in routes.ts accepting
   { lastText: string; toolNames: string[] }.

3. Export fetchSuggestions(conversationId, lastText, toolNames) from server-agent.ts.

4. In Home.tsx, after isStreaming becomes false, call fetchSuggestions() and replace
   displayedSuggestions. Show a skeleton while loading.

Fall back to static SUGGESTIONS if fetchSuggestions errors or returns empty.
```

---

### CC-9 — Run-Level Undo (Worktree Equivalent)

**Source:** `claude-code/tools/EnterWorktreeTool/`,
`claude-code/tools/ExitWorktreeTool/`

Creates a rollback point before the run starts. One click undoes everything the agent did.

**Prompt:**
```
Read claude-code/tools/EnterWorktreeTool/ and claude-code/tools/ExitWorktreeTool/.

Implement run-level isolation for Corpus using Studio change history:

1. In runtime.ts execute() iteration 1, call the Studio plugin via:
   execute_luau: `game:GetService("ChangeHistoryService"):SetWaypoint("Corpus:run-start")`
   Store the waypointName in ActiveRun. This happens automatically, no user approval needed.

2. Add POST /agent/conversations/:id/runs/:runId/restore in routes.ts.
   Only allowed when run.status is "completed" or "cancelled".
   Calls execute_luau: `game:GetService("ChangeHistoryService"):Undo()`

3. In Home.tsx, after a run completes, show a small "Undo run" button below the last
   assistant message. On click, call the restore endpoint.

This gives users one-click "revert everything this agent did" without git.
```

---

### CC-10 — Cost Tracking

**Source:** `claude-code/costHook.ts`, `claude-code/cost-tracker.ts`

Shows per-run token count and estimated USD cost at the end of each run.

**Prompt:**
```
Read claude-code/costHook.ts and claude-code/cost-tracker.ts.

Add per-run cost tracking to Corpus:

1. In server/agent/drivers.ts, have ModelDriver.generate() return:
   { text, toolCalls, usage: { inputTokens: number, outputTokens: number } }
   Most OpenRouter models return usage in the response body.

2. In runtime.ts, accumulate usage across iterations in ActiveRun:
   totalInputTokens, totalOutputTokens.
   Include these in the run_completed event payload.

3. Add inputTokens and outputTokens to AgentEventData for run_completed in types.ts.

4. Add src/lib/ai/cost.ts with estimateCost(model, inputTokens, outputTokens): number
   using hardcoded per-million-token prices for Corpus's models.

5. In server-agent.ts read usage from run_completed and call
   callbacks.onCostEstimate({ inputTokens, outputTokens, estimatedUsd }).

6. In Home.tsx after a run completes, show a small cost badge on the assistant message:
   "~$0.03 · 12k tokens". Click to expand the input/output breakdown.
```

---

### CC-11 — MCP as First-Class Tool Source

**Source:** `claude-code/services/mcp/client.ts`,
`claude-code/services/mcp/MCPConnectionManager.tsx`,
`claude-code/tools/MCPTool/`

Full MCP server management — discover tools, handle auth, classify risk per tool.

**Prompt:**
```
Read claude-code/services/mcp/client.ts, MCPConnectionManager.tsx, and claude-code/tools/MCPTool/.

Upgrade Corpus's MCP integration:

1. In server/agent/mcp-server.ts, expose each MCP tool as a first-class AgentTool
   dynamically built from the MCP server's tools/list response (same pattern as
   RobloxStudioMcpGateway but from live tool list).

2. Add MCP server config: CORPUS_MCP_SERVERS=name1:url1,name2:url2 in .env.
   Load each server's tools on startup and add to allTools in server/index.js.

3. Add GET /agent/mcp/status in routes.ts: returns connected servers, their tools,
   and last error for each.

4. In ConnectionBadges.tsx add an MCP badge showing connected server count.

5. Risk classification for MCP tools: default to "mutation" unless the tool name
   contains "read", "get", "list", "search" → "read" risk.

Keep the existing mcp-server.ts JSON-RPC adapter for the Studio plugin unchanged.
```

---

### CC-12 — Vim Mode for the Composer

**Source:** `claude-code/vim/`

Full vim keybindings for the text input.

**Prompt:**
```
Read claude-code/vim/ (all files).

Add optional vim mode to Corpus's composer:

1. Add src/lib/vim.ts: minimal vim state machine from claude-code/vim/.
   Modes: insert | normal | visual.
   Basic motions: hjkl, w, b, e, 0, $, gg, G.
   Operators: d, c, y. Text objects: iw, aw, i", a".

2. In src/stores/settings.ts add vimMode: boolean (default false, persisted).

3. In CorpusComposer, if vimMode is true, attach the vim key handler to the textarea.
   Show current mode (INSERT / NORMAL / VISUAL) in small text at the bottom-right.

4. Add vim toggle in SettingsDialog.tsx under "Editor preferences".

5. Escape from INSERT → NORMAL. i/a/o from NORMAL → INSERT.
   Never change behaviour for non-vim users.
```

---

## Summary

| Section | What | Do it when |
|---------|------|------------|
| Part 1 #1 | Scope approval + full-access UI | Now — unblocks daily use |
| Part 1 #2 | Wire structured-diff.ts into UI | Now — small, high visual impact |
| Part 2 Fix 1-3 | Corpus code bugs | This week |
| Part 2 Fix 4 | Ingest game data | This week (ops) |
| Part 1 #4-5 | Login/logout polish | Before user launch |
| Part 1 #5 | Production env + deploy | Before user launch |
| CC-1 | Color diff | After diff wire-up above |
| CC-2 | Full-access toggle | Already in Part 1 #1 above |
| CC-4 | Plan mode steps | After plan mode is used in practice |
| CC-5 | Session memory | High value, medium effort |
| CC-6 | Task tracking | High value during long runs |
| CC-7 | Auto-compact | Required before heavy use |
| CC-8 | Prompt suggestions | Nice to have |
| CC-9 | Run-level undo | Nice to have |
| CC-10 | Cost tracking | Nice to have |
| CC-3, 11, 12 | Subagents, MCP, Vim | Advanced / optional |
