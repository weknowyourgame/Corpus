# Roblox RAG Pipeline

This doc explains how to retrieve relevant Roblox game code before each model call.

## 1. RAG In An Agentic Context

RAG means retrieving relevant external context and adding it to the model input. In an agent, retrieval can happen:

- before the first model call for a user request,
- after a tool returns new clues,
- before a follow-up turn,
- inside a specialized subagent,
- reactively after the model asks to inspect something.

For Roblox, retrieval should happen before each model call where the model is expected to reason about project code. The query should include:

- user request,
- current Studio selection,
- game tree,
- logs/diagnostics,
- recent tool results,
- names/symbols from recent messages.

## 2. Chunking Luau Scripts

Good chunk granularity:

- Whole small scripts.
- Individual top-level functions.
- ModuleScript public API sections.
- Related private helper functions grouped with their caller.
- Event connection blocks plus handler functions.
- RemoteEvent/RemoteFunction handlers as standalone chunks.
- Class/table method groups for OOP-style modules.

Avoid chunks that are:

- arbitrary fixed-size slices,
- missing imports/requires,
- missing enclosing module/table name,
- too large to scan,
- too tiny to understand.

Each chunk should include enough header context:

- full instance path,
- script type,
- service/container,
- required modules,
- exported names,
- enclosing table/class,
- line range or source span if available.

## 3. Metadata Per Roblox Chunk

Useful metadata:

- `gameId` / corpus source.
- place name/version.
- full Roblox instance path.
- class name: `Script`, `LocalScript`, `ModuleScript`.
- run side: server, client, shared, plugin, unknown.
- service/container.
- Rojo path if applicable.
- symbols defined.
- symbols referenced.
- required modules.
- remotes used or defined.
- services accessed.
- CollectionService tags.
- attributes referenced.
- diagnostics/lint quality.
- code license/source.
- freshness timestamp.
- duplicate cluster ID.
- quality score.

## 4. ElasticSearch Vs Vector Search

Keyword search is best for:

- exact symbol names,
- instance paths,
- service names,
- error messages,
- stack traces,
- RemoteEvent names,
- function names.

Vector search is best for:

- conceptual similarity,
- “how does combat damage work?”,
- examples of patterns,
- similar UI/controller architecture,
- code with different naming.

Hybrid search is best for Roblox code retrieval. Use keyword search to guarantee exact matches and vector search to find conceptual neighbors. Re-rank with metadata and quality signals.

ElasticSearch gives:

- inverted index keyword search,
- filters,
- aggregations,
- BM25 ranking,
- optional vector/hybrid search depending on setup.

Pure vector DB gives:

- semantic similarity,
- weaker exact-symbol behavior unless paired with metadata filters.

## 5. Where Retrieval Fits In This Codebase

Best insertion point: inside the request pipeline just before the model call in `/Users/sarthakkapila/src/query.ts`, after the latest messages/tool results are known and before `deps.callModel`.

Relevant location:

```ts
// /Users/sarthakkapila/src/query.ts:659
for await (const message of deps.callModel({
  ...
  messages: normalizeMessagesForAPI(
    prependUserContext(
      messagesForQuery,
      await userContext,
      ...
    ),
  ),
  systemPrompt: fullSystemPrompt,
```

A Roblox retrieval layer should augment `userContext` or add a dedicated retrieved-context message before `normalizeMessagesForAPI`.

There is also an existing prefetch pattern near the start of the loop:

```ts
// /Users/sarthakkapila/src/query.ts:297
const relevantMemoryPrefetch =
  messages.length > 0
    ? startRelevantMemoryPrefetch({
        messages,
        querySource,
        signal: toolUseContext.abortController.signal,
      })
    : null
```

For Roblox, you can prefetch likely chunks early, then finalize retrieval after Studio context arrives.

## 6. Presenting Retrieved Context

Use authoritative, labeled blocks:

```text
<roblox_rag_context>
Authority order:
1. Live Studio project
2. Current project index
3. Official Roblox docs
4. Approved example corpus

Chunk:
source_type: live_project
path: game.ServerScriptService.Combat.DamageService
class: ModuleScript
run_side: server
reason: exact symbol match "ApplyDamage"
quality: high
content:
```luau
...
```
</roblox_rag_context>
```

Do not mix retrieved chunks into natural prose. The model should see them as evidence with provenance.

## 7. Retrieval Budget

Suggested budget per request:

- 1 concise Studio state block.
- 3 to 8 high-relevance code chunks.
- 1 to 3 official doc snippets only when API uncertainty exists.
- 1 to 3 corpus examples only when project code is insufficient.

Prefer fewer, higher-quality chunks. For code generation, irrelevant chunks are worse than missing chunks because they invite the model to copy the wrong pattern.

