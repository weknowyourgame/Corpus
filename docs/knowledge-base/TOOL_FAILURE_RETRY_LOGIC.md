# Tool Failure And Retry Logic

This doc explains what happens when a tool call fails and how retries work. There are two separate retry layers:

- API retry: retrying failed model requests.
- Agent retry: feeding tool errors back to the model so the model can decide the next action.

## 1. Tool Execution Path

The model emits `tool_use` blocks. The main loop collects them, queues execution, then appends `tool_result` blocks back into the conversation.

Actual code:

```ts
// /Users/sarthakkapila/src/query.ts:826
case 'tool_use':
  queryCheckpoint('streaming_tool_use')
  if (streamingToolExecutor) {
    streamingToolExecutor.addToolUse({
      toolUse: content,
      assistantMessage: assistantMessage.message,
      preventContinuation,
    })
  }
  needsFollowUp = true
```

```ts
// /Users/sarthakkapila/src/query.ts:847
for await (const completedToolUse of streamingToolExecutor.completedToolUses()) {
  const messages = completedToolUse.messages
  for (const msg of messages) {
    yield msg
  }
  toolResults.push(...messages)
}
```

Then, if a follow-up turn is needed, those tool results become part of the next model input:

```ts
// /Users/sarthakkapila/src/query.ts:1715
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

## 2. Tool Input Validation Errors

Tool inputs are validated before execution. If validation fails, the agent does not run the tool. It returns a `tool_result` containing a structured error back to the model.

Actual code:

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:599
export async function* checkPermissionsAndCallTool(
  toolName: string,
  input: unknown,
  context: ToolUseContext,
  assistantMessage: APIAssistantMessage,
  toolUseID: ToolUseID,
  options: {
    onlyCheckingPermissions?: boolean
    incompleteToolCall?: boolean
    executionMarker?: ToolExecutionMarker
  } = {},
): AsyncGenerator<Message, UserMessage> {
  const tool = findToolByName(context.options.tools, toolName)
```

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:638
const validatedInput = await tool.inputSchema.safeParseAsync(input)

if (!validatedInput.success) {
  const errors = z.prettifyError(validatedInput.error)
  const result = {
    content: [
      {
        type: 'tool_result' as const,
        content:
          `<tool_use_error>InputValidationError: ${errors}\n\n` +
          `Input received: ${JSON.stringify(input, null, 2)}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ],
  }
  return createUserMessage(result)
}
```

The model sees that as an error result and can choose to retry with corrected arguments.

## 3. Permission Denials And Hook-Approved Retry

If a permission check denies the tool, the denial is returned as a tool error. If a permission-denied hook later approves it, the loop adds a meta message telling the model it may retry.

Actual code:

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:995
if (permissionResult.behavior === 'deny') {
  const toolUseErrorMessage = formatPermissionDenialMessage(
    toolName,
    permissionResult.message,
  )
  ...
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: toolUseErrorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
      ...hookRetryMessages,
    ],
  })
}
```

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:1082
if (eventName === 'PermissionDenied' && decision?.decision === 'allow') {
  hookRetryMessages.push({
    type: 'text',
    text:
      'The PermissionDenied hook indicated this command is now approved. ' +
      'You may retry it if you would like.',
  })
}
```

## 4. Tool Runtime Errors

The tool runner executes the tool and maps its result into a `tool_result` block. Runtime failures are represented as tool results or thrown errors depending on the tool and executor path.

Actual code:

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:1206
const result = await tool.call(
  validatedInput.data as never,
  {
    ...context,
    abortController,
    messageId,
  },
  canUseTool,
)
```

```ts
// /Users/sarthakkapila/src/services/tools/toolExecution.ts:1290
return createUserMessage({
  content: [
    tool.mapToolResultToToolResultBlockParam(data, toolUseID, cacheControl),
  ],
})
```

The main loop does not automatically retry the same failed tool call. It returns the error to the model, and the model decides whether to try again, call a different tool, ask the user, or stop.

## 5. Sibling Tool Cancellation

When multiple tool calls are running and one fails, the streaming executor can synthesize cancellation results for sibling tools.

Actual code:

```ts
// /Users/sarthakkapila/src/services/tools/StreamingToolExecutor.ts:153
private createToolResultErrorMessage(
  toolUseId: ToolUseID,
  reason: 'user_interrupt' | 'sibling_error' | 'fallback_triggered',
): Message {
  const content =
    reason === 'user_interrupt'
      ? 'Tool execution interrupted by user'
      : reason === 'sibling_error'
        ? 'Tool execution aborted due to previous tool error'
        : 'Tool execution superseded by fallback model'
```

## 6. Model/API Retries

Model API calls have transport-level retry logic in `/Users/sarthakkapila/src/services/api/withRetry.ts`. This is separate from tool-call retries.

Actual code:

```ts
// /Users/sarthakkapila/src/services/api/withRetry.ts:189
for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
  if (options.signal?.aborted) {
    throw new APIUserAbortError()
  }
  try {
    ...
    return await operation(client, attempt, retryContext)
  } catch (error) {
    lastError = error
```

```ts
// /Users/sarthakkapila/src/services/api/withRetry.ts:367
const persistent =
  isPersistentRetryEnabled() && isTransientCapacityError(error)
if (attempt > maxRetries && !persistent) {
  throw new CannotRetryError(error, retryContext)
}

if (
  !handledCloudAuthError &&
  (!(error instanceof APIError) || !shouldRetry(error))
) {
  throw new CannotRetryError(error, retryContext)
}
```

Retryable statuses include connection errors, 408, 409, some 429s, 401 refresh cases, OAuth token revocation, overloaded errors, and selected max-token context overflow cases.

```ts
// /Users/sarthakkapila/src/services/api/withRetry.ts:753
if (error instanceof APIConnectionError) {
  return true
}
if (!error.status) return false
if (error.status === 408) return true
if (error.status === 409) return true
if (error.status === 429) {
  return !isClaudeAISubscriber() || isEnterpriseSubscriber()
}
if (error.status === 401) {
  clearApiKeyHelperCache()
  return true
}
```

## 7. Prompt Too Long And Output Too Long

When the model call fails because the prompt is too long, the query loop tries context recovery/compaction before giving up.

Actual code:

```ts
// /Users/sarthakkapila/src/query.ts:1065
if (
  lastMessage?.isApiErrorMessage &&
  (lastMessage.api_error.type === 'prompt_too_long' ||
    lastMessage.api_error.type === 'media_processing_failed')
) {
  ...
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

When output tokens run out, the model gets a meta instruction to resume directly:

```ts
// /Users/sarthakkapila/src/query.ts:1223
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
  const recoveryMessage = createUserMessage({
    content:
      `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
      `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
    isMeta: true,
  })
```

## 8. How Many Times Does It Retry?

Tool calls: there is no universal automatic retry count. The failed result is fed back to the model. The model decides what to do next.

API calls: retry count is controlled by the caller’s `maxRetries` option. Some model call paths set `maxRetries: 0`; persistent retry mode can continue retrying transient capacity errors with heartbeat messages.

Conversation turns: if tool results require a follow-up, the loop continues until no follow-up is needed or `maxTurns` is exceeded.

```ts
// /Users/sarthakkapila/src/query.ts:1704
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

