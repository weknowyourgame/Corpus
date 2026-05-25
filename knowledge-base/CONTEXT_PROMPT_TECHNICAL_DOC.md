# Context and Prompt Construction Technical Documentation

This document focuses on how this codebase constructs the context/prompt sent to the model. It also traces the surrounding request flow, agent loop, tool execution, retry/compaction behavior, and file indexing logic because those shape what ultimately reaches the model.

## High-Level Request Flow

The interactive REPL path constructs context in `screens/REPL.tsx`, then hands it to the agent loop in `query.ts`.

```ts
// screens/REPL.tsx:2767-2787
queryCheckpoint('query_context_loading_start');
const [,, defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
  checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState),
  feature('TRANSCRIPT_CLASSIFIER') ? checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode) : undefined,
  getSystemPrompt(freshTools, mainLoopModelParam, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), freshMcpClients),
  getUserContext(),
  getSystemContext()
]);
const userContext = {
  ...baseUserContext,
  ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
  ...((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive() && !terminalFocusRef.current ? {
    terminalFocus: 'The terminal is unfocused — the user is not actively watching.'
  } : {})
};
queryCheckpoint('query_context_loading_end');
const systemPrompt = buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt
});
```

Then the REPL starts the loop:

```ts
// screens/REPL.tsx:2793-2801
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource: getQuerySourceForREPL()
})) {
  onQueryEvent(event);
}
```

The headless/SDK path uses `QueryEngine.ts`. It fetches the same three prompt pieces (`defaultSystemPrompt`, `userContext`, `systemContext`), processes user input/slash commands, pushes the resulting messages, then calls `query()`.

```ts
// QueryEngine.ts:288-325
const {
  defaultSystemPrompt,
  userContext: baseUserContext,
  systemContext,
} = await fetchSystemPromptParts({
  tools,
  mainLoopModel: initialMainLoopModel,
  additionalWorkingDirectories: Array.from(
    initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
  ),
  mcpClients,
  customSystemPrompt: customPrompt,
})
const userContext = {
  ...baseUserContext,
  ...getCoordinatorUserContext(
    mcpClients,
    isScratchpadEnabled() ? getScratchpadDir() : undefined,
  ),
}
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

```ts
// QueryEngine.ts:675-686
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
```

## Where The Agent Loop Lives

The agent loop is `queryLoop()` in `query.ts`. It is the planning/execution/retry loop: it calls the model, collects assistant tool calls, executes tools, appends tool results/attachments, then loops for a follow-up model call.

```ts
// query.ts:241-279
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params

  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
```

The actual model call is inside the loop:

```ts
// query.ts:659-707
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    async getToolPermissionContext() {
      const appState = toolUseContext.getAppState()
      return appState.toolPermissionContext
    },
    model: currentModel,
    toolChoice: undefined,
    isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    fallbackModel,
    querySource,
    agents: toolUseContext.options.agentDefinitions.activeAgents,
    maxOutputTokensOverride,
    mcpTools: appState.mcp.tools,
    hasPendingMcpServers: appState.mcp.clients.some(c => c.type === 'pending'),
    queryTracking,
    effortValue: appState.effortValue,
    advisorModel: appState.advisorModel,
    skipCacheWrite,
    agentId: toolUseContext.agentId,
  },
})) {
```

## What Is Always Included

There are three baseline buckets:

1. `systemPrompt`: built by `getSystemPrompt()` in `constants/prompts.ts`.
2. `userContext`: prepended as a synthetic user `<system-reminder>` message.
3. `systemContext`: appended to the system prompt as `key: value` lines.

The shared loader is `utils/queryContext.ts`.

```ts
// utils/queryContext.ts:44-73
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}) {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}
```

`userContext` always includes the current date and may include discovered `CLAUDE.md`/memory content:

```ts
// context.ts:155-187
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

`systemContext` includes a startup git snapshot when enabled and the cwd is a git repo:

```ts
// context.ts:116-148
export const getSystemContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }
        : {}),
    }
  },
)
```

The code then injects those buckets into the actual request:

```ts
// query.ts:449-450
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

```ts
// utils/api.ts:437-446
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

```ts
// utils/api.ts:449-473
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (Object.entries(context).length === 0) {
    return messages
  }

  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(
        context,
      )
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

## System Prompt Definition

The system prompt is defined and assembled in `constants/prompts.ts`. It has a cache-boundary marker:

```ts
// constants/prompts.ts:107-115
/**
 * Everything BEFORE this marker in the system prompt array can use scope: 'global'.
 * Everything AFTER contains user/session-specific content and should not be cached.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

Core simple sections include the identity, cyber-risk instruction, tool-reminder rules, hook rules, and context-compression statement:

```ts
// constants/prompts.ts:175-196
function getSimpleIntroSection(
  outputStyleConfig: OutputStyleConfig | null,
): string {
  return `
You are an interactive agent that helps users ${outputStyleConfig !== null ? 'according to your "Output Style" below, which describes how you should respond to user queries.' : 'with software engineering tasks.'} Use the instructions below and the tools available to you to assist the user.

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`
}

function getSimpleSystemSection(): string {
  const items = [
    `All text you output outside of tool use is displayed to the user...`,
    `Tools are executed in a user-selected permission mode...`,
    `Tool results and user messages may include <system-reminder> or other tags...`,
    `Tool results may include data from external sources...`,
    getHooksSection(),
    `The system will automatically compress prior messages in your conversation as it approaches context limits. This means your conversation with the user is not limited by the context window.`,
  ]
  return ['# System', ...prependBullets(items)].join(`\n`)
}
```

Dynamic sections are resolved near the end of `getSystemPrompt()`:

```ts
// constants/prompts.ts:491-558
const dynamicSections = [
  systemPromptSection('session_guidance', () =>
    getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
  ),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('ant_model_override', () =>
    getAntModelOverrideSection(),
  ),
  systemPromptSection('env_info_simple', () =>
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ),
  systemPromptSection('language', () =>
    getLanguageSection(settings.language),
  ),
  systemPromptSection('output_style', () =>
    getOutputStyleSection(outputStyleConfig),
  ),
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () =>
      isMcpInstructionsDeltaEnabled()
        ? null
        : getMcpInstructionsSection(mcpClients),
    'MCP servers connect/disconnect between turns',
  ),
  systemPromptSection('scratchpad', () => getScratchpadInstructions()),
  systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
  systemPromptSection(
    'summarize_tool_results',
    () => SUMMARIZE_TOOL_RESULTS_SECTION,
  ),
]

const resolvedDynamicSections =
  await resolveSystemPromptSections(dynamicSections)
```

Additional environment details can be appended:

```ts
// constants/prompts.ts:760-790
export async function enhanceSystemPromptWithEnvDetails(
  existingSystemPrompt: string[],
  model: string,
  additionalWorkingDirectories?: string[],
  enabledToolNames?: ReadonlySet<string>,
): Promise<string[]> {
  const notes = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task...
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls...`
  const envInfo = await computeEnvInfo(model, additionalWorkingDirectories)
  return [
    ...existingSystemPrompt,
    notes,
    ...(discoverSkillsGuidance !== null ? [discoverSkillsGuidance] : []),
    envInfo,
  ]
}
```

## Dynamic Retrieval And Attachments

Dynamic context arrives as attachments after model/tool iterations, and as memory/skill prefetches.

`query.ts` starts memory prefetch once per user turn:

```ts
// query.ts:297-304
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

The prefetch is implemented in `utils/attachments.ts` and uses the latest real user message:

```ts
// utils/attachments.ts:2356-2399
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (
    !isAutoMemoryEnabled() ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
  ) {
    return undefined
  }

  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })
```

If it resolves before the next model-call iteration, it is injected as attachment messages:

```ts
// query.ts:1592-1614
if (
  pendingMemoryPrefetch &&
  pendingMemoryPrefetch.settledAt !== null &&
  pendingMemoryPrefetch.consumedOnIteration === -1
) {
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,
  )
  for (const memAttachment of memoryAttachments) {
    const msg = createAttachmentMessage(memAttachment)
    yield msg
    toolResults.push(msg)
  }
  pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
}
```

General attachments are retrieved by `getAttachmentMessages()`:

```ts
// utils/attachments.ts:2937-2969
export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}
```

The loop injects those attachment messages after tool execution and before the follow-up model call:

```ts
// query.ts:1580-1590
for await (const attachment of getAttachmentMessages(
  null,
  updatedToolUseContext,
  null,
  queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}
```

## RAG Or Semantic Search

There is no general codebase RAG pipeline in the main prompt path. Code/files are made available through tools, explicit attachments, `CLAUDE.md` discovery, file-read state, and a fuzzy file index. The only semantic-looking retrieval in this prompt path is auto-memory relevance selection, which is gated behind `isAutoMemoryEnabled()` and a feature flag, and calls `getRelevantMemoryAttachments()` from `utils/attachments.ts`.

There are side-query semantic helpers elsewhere, such as `utils/agenticSessionSearch.ts`, but that searches prior sessions, not project code for every model request.

The file/codebase index is fuzzy path search, not embeddings:

```ts
// native-ts/file-index/index.ts:1-15
/**
 * Pure-TypeScript port of vendor/file-index-src (Rust NAPI module).
 *
 * The native module wraps nucleo ... for high-performance fuzzy file searching.
 *
 * Key API:
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void   — dedupe + index paths
 *   .search(query: string, limit: number): SearchResult[]
 *
 * Score semantics: lower = better...
 */
```

```ts
// native-ts/file-index/index.ts:53-70
/**
 * Load paths from an array of strings.
 * This is the main way to populate the index — ripgrep collects files, we just search them.
 * Automatically deduplicates paths.
 */
loadFromFileList(fileList: string[]): void {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of fileList) {
    if (line.length > 0 && !seen.has(line)) {
      seen.add(line)
      paths.push(line)
    }
  }

  this.buildIndex(paths)
}
```

```ts
// native-ts/file-index/index.ts:169-190
/**
 * Search for files matching the query using fuzzy matching.
 * Returns top N results sorted by match score.
 */
search(query: string, limit: number): SearchResult[] {
  if (limit <= 0) return []
  if (query.length === 0) {
    if (this.topLevelCache) {
      return this.topLevelCache.slice(0, limit)
    }
    return []
  }

  const caseSensitive = query !== query.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
```

## Context Window Management

There are several layers:

1. Proactive auto-compact before model call.
2. Optional context-collapse projection.
3. API context-management parameters.
4. Reactive compact on prompt-too-long errors.
5. Media truncation and tool-result/cache clearing.

Before each model request, `query.ts` applies context collapse, appends system context, and calls autocompaction:

```ts
// query.ts:428-467
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}

const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages: messagesForQuery,
  },
  querySource,
  tracking,
  snipTokensFreed,
)
```

`autoCompactIfNeeded()` checks threshold and first tries session-memory compaction:

```ts
// services/compact/autoCompact.ts:225-238
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
const threshold = getAutoCompactThreshold(model)
const effectiveWindow = getEffectiveContextWindowSize(model)

const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
  tokenCount,
  model,
)

return isAboveAutoCompactThreshold
```

```ts
// services/compact/autoCompact.ts:287-321
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages,
  toolUseContext.agentId,
  recompactionInfo.autoCompactThreshold,
)
if (sessionMemoryResult) {
  setLastSummarizedMessageId(undefined)
  runPostCompactCleanup(querySource)
  markPostCompaction()
  return {
    wasCompacted: true,
    compactionResult: sessionMemoryResult,
  }
}

const compactionResult = await compactConversation(
  messages,
  toolUseContext,
  cacheSafeParams,
  true,
  undefined,
  true,
  recompactionInfo,
)
```

Token counting uses the last API response usage plus estimates for appended messages:

```ts
// utils/tokens.ts:201-226
/**
 * Get the current context window size in tokens.
 *
 * This is the CANONICAL function for measuring context size when checking
 * thresholds (autocompact, session memory init, etc.). Uses the last API
 * response's token count (input + output + cache) plus estimates for any
 * messages added since.
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
```

```ts
// utils/tokens.ts:253-260
return (
  getTokenCountFromUsage(usage) +
  roughTokenCountEstimationForMessages(messages.slice(i + 1))
)
...
return roughTokenCountEstimationForMessages(messages)
```

## What Gets Truncated Or Dropped First

The code has several targeted drop/truncation mechanisms:

1. Git status is truncated to 2,000 chars in startup context.
2. Excess media items are dropped before API calls.
3. Large PDFs may be passed as references instead of inlined.
4. Session memory compaction keeps a suffix of messages and inserts a summary.
5. Session-memory compact summary sections are truncated when oversized.
6. Tool results may be cleared via cached microcompact/function-result clearing when enabled.

Git status truncation:

```ts
// context.ts:84-89
const truncatedStatus =
  status.length > MAX_STATUS_CHARS
    ? status.substring(0, MAX_STATUS_CHARS) +
      '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
    : status
```

Media drop before API request:

```ts
// services/api/claude.ts:1308-1315
// Strip excess media items before making the API call.
// The API rejects requests with >100 media items but returns a confusing error.
messagesForAPI = stripExcessMediaItems(
  messagesForAPI,
  API_MAX_MEDIA_PER_REQUEST,
)
```

Large PDF reference:

```ts
// utils/attachments.ts:2998-3012
const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
  return {
    type: 'pdf_reference',
    filename,
    pageCount: effectivePageCount,
    fileSize: stats.size,
    displayPath: relative(getCwd(), filename),
  }
}
```

Session-memory compaction chooses what messages to keep:

```ts
// services/compact/sessionMemoryCompact.ts:317-323
/**
 * Calculate the starting index for messages to keep after compaction.
 * Starts from lastSummarizedMessageId, then expands backwards to meet minimums:
 * - At least config.minTokens tokens
 * - At least config.minTextBlockMessages messages with text blocks
 * Stops expanding if config.maxTokens is reached.
 * Also ensures tool_use/tool_result pairs are not split.
 */
```

```ts
// services/compact/sessionMemoryCompact.ts:568-581
const startIndex = calculateMessagesToKeepIndex(
  messages,
  lastSummarizedIndex,
)
const messagesToKeep = messages
  .slice(startIndex)
  .filter(m => !isCompactBoundaryMessage(m))
```

Session memory summary truncation:

```ts
// services/compact/sessionMemoryCompact.ts:459-473
// Truncate oversized sections to prevent session memory from consuming
// the entire post-compact token budget
const { truncatedContent, wasTruncated } =
  truncateSessionMemoryForCompact(sessionMemory)

let summaryContent = getCompactUserSummaryMessage(
  truncatedContent,
  true,
  transcriptPath,
  true,
)

if (wasTruncated) {
  const memoryPath = getSessionMemoryPath()
  summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`
}
```

Function-result clearing prompt:

```ts
// constants/prompts.ts:821-839
function getFunctionResultClearingSection(model: string): string | null {
  if (!feature('CACHED_MICROCOMPACT') || !getCachedMCConfigForFRC) {
    return null
  }
  const config = getCachedMCConfigForFRC()
  ...
  return `# Function Result Clearing

Old tool results will be automatically cleared from context to free up space. The ${config.keepRecent} most recent results are always kept.`
}
```

## Model Call Parameters

`services/api/claude.ts` normalizes messages, builds tool schemas, builds system prompt blocks, and creates the Anthropic request.

Message normalization and synthetic additions:

```ts
// services/api/claude.ts:1265-1301
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)

if (!useToolSearch) {
  messagesForAPI = messagesForAPI.map(msg => {
    switch (msg.type) {
      case 'user':
        return stripToolReferenceBlocksFromUserMessage(msg)
      case 'assistant':
        return stripCallerFieldFromAssistantMessage(msg)
      default:
        return msg
    }
  })
}

messagesForAPI = ensureToolResultPairing(messagesForAPI)
```

System prompt prefix and blocks:

```ts
// services/api/claude.ts:1357-1379
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint),
    getCLISyspromptPrefix({
      isNonInteractive: options.isNonInteractiveSession,
      hasAppendSystemPrompt: options.hasAppendSystemPrompt,
    }),
    ...systemPrompt,
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
  ].filter(Boolean),
)

const enablePromptCaching =
  options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
  skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
  querySource: options.querySource,
})
```

System prompt cache blocks:

```ts
// services/api/claude.ts:3213-3236
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}
```

The final request object:

```ts
// services/api/claude.ts:1699-1728
return {
  model: normalizeModelStringForAPI(options.model),
  messages: addCacheBreakpoints(
    messagesForAPI,
    enablePromptCaching,
    options.querySource,
    useCachedMC,
    consumedCacheEdits,
    consumedPinnedEdits,
    options.skipCacheWrite,
  ),
  system,
  tools: allTools,
  tool_choice: options.toolChoice,
  ...(useBetas && { betas: betasParams }),
  metadata: getAPIMetadata(),
  max_tokens: maxOutputTokens,
  thinking,
  ...(temperature !== undefined && { temperature }),
  ...(contextManagement &&
    useBetas &&
    betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
      context_management: contextManagement,
    }),
  ...extraBodyParams,
  ...(Object.keys(outputConfig).length > 0 && {
    output_config: outputConfig,
  }),
  ...(speed !== undefined && { speed }),
}
```

And the streaming API call:

```ts
// services/api/claude.ts:1818-1832
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    {
      signal,
      ...(clientRequestId && {
        headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
      }),
    },
  )
  .withResponse()
```

## Tool Calls / Function Calls

Tool schemas are generated in `utils/api.ts` by converting each `Tool` to Anthropic tool schema:

```ts
// utils/api.ts:119-177
export async function toolToAPISchema(
  tool: Tool,
  options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
    deferLoading?: boolean
    cacheControl?: {
      type: 'ephemeral'
      scope?: 'global' | 'org'
      ttl?: '5m' | '1h'
    }
  },
): Promise<BetaToolUnion> {
  const cacheKey =
    'inputJSONSchema' in tool && tool.inputJSONSchema
      ? `${tool.name}:${jsonStringify(tool.inputJSONSchema)}`
      : tool.name
  const cache = getToolSchemaCache()
  let base = cache.get(cacheKey)
  if (!base) {
    let input_schema = (
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    ) as Anthropic.Tool.InputSchema

    base = {
      name: tool.name,
      description: await tool.prompt({
        getToolPermissionContext: options.getToolPermissionContext,
        tools: options.tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
      }),
      input_schema,
    }
```

Tool execution runs through `services/tools/toolExecution.ts`: hooks, permission decision, execution, and tool-result user messages.

```ts
// services/tools/toolExecution.ts:916-931
// Check whether we have permission to use the tool,
// and ask the user for permission if we don't
const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
const permissionStart = Date.now()

const resolved = await resolveHookPermissionDecision(
  hookPermissionResult,
  tool,
  processedInput,
  toolUseContext,
  canUseTool,
  assistantMessage,
  toolUseID,
)
const permissionDecision = resolved.decision
processedInput = resolved.input
```

Denied tools become `tool_result` error messages:

```ts
// services/tools/toolExecution.ts:1029-1070
const messageContent: ContentBlockParam[] = [
  {
    type: 'tool_result',
    content: errorMessage,
    is_error: true,
    tool_use_id: toolUseID,
  },
]

resultingMessages.push({
  message: createUserMessage({
    content: messageContent,
    imagePasteIds: rejectImageIds,
    toolUseResult: `Error: ${errorMessage}`,
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
})
```

Streaming tool execution is queued/concurrency-aware:

```ts
// services/tools/StreamingToolExecutor.ts:126-150
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}

private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue

    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      if (!tool.isConcurrencySafe) break
    }
  }
}
```

## Errors And Retries

There are three important retry layers:

1. API/network retry in `services/api/withRetry.ts`, used by the Anthropic call.
2. Streaming-to-non-streaming fallback in `services/api/claude.ts`.
3. Prompt-too-long and max-output recovery in `query.ts`.

The client disables SDK auto-retry and uses the custom retry wrapper:

```ts
// services/api/claude.ts:1776-1785
const generator = withRetry(
  () =>
    getAnthropicClient({
      maxRetries: 0, // Disabled auto-retry in favor of manual implementation
      model: options.model,
      fetchOverride: options.fetchOverride,
      source: options.querySource,
    }),
```

Streaming fallback:

```ts
// services/api/claude.ts:2504-2512
logForDebugging(
  `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
  { level: 'error' },
)
didFallBackToNonStreaming = true
if (options.onStreamingFallback) {
  options.onStreamingFallback()
}
```

```ts
// services/api/claude.ts:2551-2562
const result = yield* executeNonStreamingRequest(
  { model: options.model, source: options.querySource },
  {
    model: options.model,
    fallbackModel: options.fallbackModel,
    thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: isFastMode }),
    signal,
    initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
    querySource: options.querySource,
  },
  paramsFromContext,
```

Prompt-too-long recovery first drains context-collapse, then tries reactive compact:

```ts
// query.ts:1065-1073
// Prompt-too-long recovery: the streaming loop withheld the error...
const isWithheld413 =
  lastMessage?.type === 'assistant' &&
  lastMessage.isApiErrorMessage &&
  isPromptTooLongMessage(lastMessage)
```

```ts
// query.ts:1090-1115
if (
  feature('CONTEXT_COLLAPSE') &&
  contextCollapse &&
  state.transition?.reason !== 'collapse_drain_retry'
) {
  const drained = contextCollapse.recoverFromOverflow(
    messagesForQuery,
    querySource,
  )
  if (drained.committed > 0) {
    state = {
      messages: drained.messages,
      toolUseContext,
      autoCompactTracking: tracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride: undefined,
      pendingToolUseSummary: undefined,
      stopHookActive: undefined,
      turnCount,
      transition: { reason: 'collapse_drain_retry', committed: drained.committed },
    }
    continue
  }
}
```

```ts
// query.ts:1119-1165
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    querySource,
    aborted: toolUseContext.abortController.signal.aborted,
    messages: messagesForQuery,
    cacheSafeParams: {
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      forkContextMessages: messagesForQuery,
    },
  })

  if (compacted) {
    const postCompactMessages = buildPostCompactMessages(compacted)
    for (const msg of postCompactMessages) {
      yield msg
    }
    state = {
      messages: postCompactMessages,
      toolUseContext,
      autoCompactTracking: undefined,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact: true,
      maxOutputTokensOverride: undefined,
      pendingToolUseSummary: undefined,
      stopHookActive: undefined,
      turnCount,
      transition: { reason: 'reactive_compact_retry' },
    }
    continue
  }
```

