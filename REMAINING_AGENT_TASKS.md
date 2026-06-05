# Remaining Agent Tasks

Non-production follow-up work only. Do not add deployment, production env, OAuth domain, hosting, or release-hardening tasks here.

---

## Task 1 — Finish Corpus Embedding

**Goal:** Finish embedding the remaining corpus games into Vectorize and mark them ingested in Postgres.

**Current known state:**

- `sync-corpus.ts` succeeded: 439 synced, 18 already done, 0 failed.
- Corpus DB after the attempted full embed run: 896 games, 76 ingested, 820 pending, 1,756 chunks.
- `bun run scripts/embed-games.ts --games=all` made progress but became too slow/stalled during the all-run.

**Prompt:**

```text
Read CODEBASE.md and inspect scripts/embed-games.ts plus server/agent/corpus/*.

Complete the remaining corpus embedding work without changing production/deployment config.

Steps:
1. Check current corpus DB counts:
   - total games
   - ingested games
   - pending games
   - corpus chunk rows
2. Run embedding in safer batches instead of one huge all-run:
   - start with `bun run scripts/embed-games.ts --games=10`
   - if stable, continue with larger batches like 25 or 50
   - if a game stalls, identify its slug and run cleanup/retry only for that slug.
3. Keep failed games isolated; do not delete successful chunks/vectors.
4. After each batch, print updated counts.
5. Stop only when pending games reaches 0 or when a specific external-service blocker is identified.
6. Update CODEBASE.md with exact final counts and any failed/stalled slugs.

Verification:
- `bun run scripts/embed-games.ts --games=10` should complete without hanging.
- Postgres pending count should decrease after each successful batch.
- Final target is pendingGames: 0 from `/corpus/status`.
```

---

## Task 2 — Add a Corpus Batch/Resume Helper

**Goal:** Make corpus embedding easier to resume when all-run stalls.

**Prompt:**

```text
Read CODEBASE.md and scripts/embed-games.ts.

Add a small resume helper script for corpus embedding, without changing existing embed-games.ts behavior.

Create `scripts/embed-pending-batches.ts`:
1. Load env the same way existing corpus scripts do.
2. Query Postgres for games where `ingested=false`, ordered by `createdAt`.
3. Run `scripts/embed-games.ts --slug=<slug>` one game at a time.
4. Accept CLI flags:
   - `--limit=N` default 25
   - `--start-after=<slug>` optional
   - `--dry-run`
5. Print per-game duration, success/failure, and final counts.
6. On failure, continue to the next game and print a final failed-slug list.
7. Do not delete or re-embed successful games.

Update package.json with a script:
`corpus:embed-pending`

Run:
- `npm run typecheck`
- `bun run scripts/embed-pending-batches.ts --limit=3 --dry-run`

Update CODEBASE.md with the new script and usage.
```

---

## Task 3 — Verify Corpus Retrieval Quality

**Goal:** Confirm `/corpus/debug` and real retrieval produce useful Roblox context after embeddings are populated.

**Prompt:**

```text
Read CODEBASE.md, server/index.js, server/agent/corpus/retrieve.ts, and server/agent/rag.ts.

Verify corpus retrieval after embedding is populated.

Steps:
1. Start the bridge locally.
2. Call `GET /corpus/status` and record enabled/ready/pendingGames.
3. Call `GET /corpus/debug` and inspect:
   - detectedNiche
   - totalFound
   - selected chunks
   - scores
   - R2 paths
4. If `/corpus/debug` returns no chunks while corpus is ready and pending is low/zero:
   - turn on `CORPUS_LOG_RETRIEVAL=true`
   - inspect score filtering logs
   - adjust only retrieval calibration if needed, not data ingestion scripts.
5. Test these queries through `retrieveCorpusContext()` or an agent run:
   - "help me build a tycoon dropper income system"
   - "make a shop GUI with coins"
   - "create a gun damage system with server validation"
6. Update CODEBASE.md with retrieval results and any calibration change.

Verification:
- `/corpus/debug` returns at least one relevant chunk once corpus data exists.
- Logs show the expected niche index or all-index fallback.
- `npm run typecheck` passes if code changed.
```

---

## Task 4 — Improve External MCP Runtime Management UI

**Goal:** Move MCP management beyond a read-only status panel while keeping env-based config as the source of truth.

**Prompt:**

```text
Read CODEBASE.md, server/agent/mcp-server.ts, server/agent/routes.ts, src/components/chat/ConnectionBadges.tsx, and claude-code/services/mcp/* for reference patterns.

Improve the MCP management experience without adding production/deployment tasks.

Requirements:
1. Keep `CORPUS_MCP_SERVERS=name:url` as the server-side source of truth.
2. Add a richer MCP status response from `GET /agent/mcp/status`:
   - configured raw count
   - connected count
   - total tool count
   - per-server name, url, connected, tools, lastError
   - last loaded timestamp
3. In the MCP dialog UI:
   - show summary counts
   - show full tool list with search/filter
   - show copyable env snippet format
   - show a refresh button that re-fetches status
4. Do not implement browser-side secret storage.
5. Do not add/remove MCP servers from the browser unless the server already exposes a safe non-secret config endpoint.

Verification:
- `npm run typecheck`
- MCP dialog still renders when no servers are configured.
- MCP dialog clearly displays errors when a configured server fails.

Update CODEBASE.md with any new MCP fields or UI behavior.
```

---



