# Context Compaction And Truncation

This doc explains what happens when the conversation gets long.

## 1. Where Compaction Is Triggered

The main query loop checks whether auto-compaction is needed before calling the model.

```ts
// /Users/sarthakkapila/src/query.ts:428
const collapseProjections = await Promise.all(
  normalizedMessages.map(m =>
    projectMessageForContextCollapse(m, toolUseContext),
  ),
)

const fullSystemPrompt = appendSystemContext(
  await systemPrompt,
  systemContext,
  normalizedMessages,
)

const { result: autoCompactResult, tracking } = yield* autoCompactIfNeeded({
  querySource,
  messages: normalizedMessages,
  toolUseContext,
  systemPrompt: fullSystemPrompt,
  userContext,
  assistantMessages: [],
  autoCompactTracking,
})
```

If compaction returns replacement messages, they become the next state:

```ts
// /Users/sarthakkapila/src/query.ts:495
const postCompactMessages = buildPostCompactMessages(autoCompactResult)

const next: State = {
  messages: postCompactMessages,
  toolUseContext: compactedToolUseContext,
  autoCompactTracking: tracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  pendingToolUseSummary,
  maxOutputTokensOverride,
  stopHookActive,
  turnCount,
  transition: {
    reason: 'auto_compact',
    compactReason: autoCompactResult.compactReason,
  },
}
state = next
continue
```

## 2. Auto-Compact Decision

Auto-compact can be disabled, skipped for certain query sources, or triggered based on token count.

```ts
// /Users/sarthakkapila/src/services/compact/autoCompact.ts:160
export async function shouldAutoCompact({
  messages,
  autoCompactTracking,
  tokenBudget,
  querySource,
  toolUseContext,
  force = false,
}: ShouldAutoCompactParams): Promise<boolean> {
  if (force) {
    return true
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
```

The token count uses API-reported usage where available, then estimates around it.

```ts
// /Users/sarthakkapila/src/utils/tokens.ts:226
export function getTokenCount(
  messages: Message[],
  systemPrompt: string,
  options: TokenCountOptions = {},
): number {
  const canonicalCount = findLastCanonicalTokenCount(messages)
  if (canonicalCount !== null) {
    return canonicalCount.total
  }
  return estimateTokenCount(messages, systemPrompt, options)
}
```

## 3. What Stays After Compaction

The compacted conversation is rebuilt in a fixed order:

1. A boundary marker.
2. Summary messages.
3. Messages selected to keep.
4. Attachments.
5. Hook results.

Actual code:

```ts
// /Users/sarthakkapila/src/services/compact/compact.ts:328
export function buildPostCompactMessages(
  result: CompactedConversationResult,
): Message[] {
  return [
    ...(result.boundaryMarker ? [result.boundaryMarker] : []),
    ...result.summaryMessages,
    ...result.messagesToKeep,
    ...(result.attachments ?? []),
    ...(result.hookResults ?? []),
  ]
}
```

The system prompt is not dropped. It is rebuilt each turn from prompt definitions plus current system context.

## 4. Session Memory Compact

Before full conversation compaction, the system may try a session-memory compaction path.

```ts
// /Users/sarthakkapila/src/services/compact/autoCompact.ts:287
if (sessionMemoryEnabled && !force) {
  const sessionMemoryCompactResult = yield* trySessionMemoryCompact({
    messages,
    toolUseContext,
    systemPrompt,
    userContext,
    assistantMessages,
    agentId: toolUseContext.agentId,
    tracking,
  })

  if (sessionMemoryCompactResult.didCompact) {
    notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    return {
      result: sessionMemoryCompactResult.result,
      tracking: sessionMemoryCompactResult.tracking,
    }
  }
}
```

Session memory chooses a suffix of recent messages to keep, with tool-use pair preservation.

```ts
// /Users/sarthakkapila/src/services/compact/sessionMemoryCompact.ts:317
async function calculateMessagesToKeepIndex({
  messages,
  lastSummarizedIndex,
  systemPrompt,
  targetMinTokens,
  targetMaxTokens,
  textBlockMessageLimit,
  agentId,
}: CalculateMessagesToKeepIndexParams): Promise<number> {
  const effectiveFloor = findCompactBoundaryIndexAfter(messages, lastSummarizedIndex)
  let keepIndex = messages.length
  let tokenCount = 0
  let textBlockCount = 0
```

## 5. Reactive Compaction

If the API says the prompt is too long, the query loop forces aggressive compaction and tries again.

```ts
// /Users/sarthakkapila/src/query.ts:1065
if (
  lastMessage?.isApiErrorMessage &&
  (lastMessage.api_error.type === 'prompt_too_long' ||
    lastMessage.api_error.type === 'media_processing_failed')
) {
  const reactiveResult = yield* autoCompactIfNeeded({
    querySource,
    messages: messagesForQuery,
    toolUseContext,
    systemPrompt,
    userContext,
    assistantMessages,
    force: true,
    aggressive: true,
    compactReason: 'reactive',
  })
```

## 6. What Gets Dropped First

The compaction strategy does not simply drop oldest messages blindly. It summarizes older conversation, keeps selected recent messages, preserves attachments/hook results, and preserves tool-use/result integrity.

Separately, media has its own pruning path: oldest media items are stripped when exceeding API limits.

```ts
// /Users/sarthakkapila/src/services/api/claude.ts:956
export function stripExcessMediaItems(
  messages: MessageParam[],
  maxMediaItems: number,
): MessageParam[] {
  const allMediaItems: Array<{ messageIndex: number; contentIndex: number }> = []
  ...
  const mediaToRemove = allMediaItems.slice(0, excessCount)
```

So the practical order is:

1. Use API token counts and estimates to detect pressure.
2. Try session-memory compact if enabled.
3. Fall back to full compact.
4. On API prompt-too-long, force aggressive compact.
5. Strip excess media separately when media limits are exceeded.

## 7. What Always Stays

Always rebuilt or preserved:

- Current system prompt.
- Current system context.
- User context injected by `prependUserContext`.
- Compact boundary marker.
- Generated summary.
- Recent kept messages.
- Valid tool-use/result pairs.
- Attachments/hook results selected by compaction.

For Roblox adaptation, live Studio state should be treated like current user/system context, not old chat history. That means it should be regenerated per request instead of relying on previous turns surviving compaction.

