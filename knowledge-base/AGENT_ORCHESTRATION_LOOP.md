# Agent Orchestration Loop

This doc explains how the agent decides what to do between tool calls.

## 1. Main Entry

The public `query` function wraps `queryLoop`.

```ts
// /Users/sarthakkapila/src/query.ts:219
export async function* query(
  params: QueryParams,
): AsyncGenerator<Message, QueryResult> {
  const deps = {
    callModel: querySonnet,
    makeStreamingToolExecutor: (toolUseContext: ToolUseContext) =>
      new StreamingToolExecutor(toolUseContext),
  }
  return yield* queryLoop(params, deps)
}
```

`queryLoop` owns turn state.

```ts
// /Users/sarthakkapila/src/query.ts:241
async function* queryLoop(
  {
    messages,
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    toolUseContext,
    querySource,
    maxTurns,
  }: QueryParams,
  deps: QueryDeps,
): AsyncGenerator<Message, QueryResult> {
  let state: State = {
    messages,
    toolUseContext,
    autoCompactTracking: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    pendingToolUseSummary: undefined,
    stopHookActive: undefined,
    turnCount: 0,
    transition: { reason: 'initial' },
  }
```

## 2. There Is No Separate Deterministic Planner

The loop does not run a separate planner module before every action. The model plans in its own response. The orchestration layer:

- Builds prompt/context.
- Calls the model.
- Streams assistant text.
- Executes requested tools.
- Feeds tool results back.
- Continues if tools were used or hooks require another turn.

The variable that drives continuation is `needsFollowUp`.

```ts
// /Users/sarthakkapila/src/query.ts:551
const assistantMessages: AssistantMessage[] = []
const toolResults: UserMessage[] = []
let needsFollowUp = false
```

When the model emits a tool call, the loop marks that another turn is needed:

```ts
// /Users/sarthakkapila/src/query.ts:826
case 'tool_use':
  if (streamingToolExecutor) {
    streamingToolExecutor.addToolUse({
      toolUse: content,
      assistantMessage: assistantMessage.message,
      preventContinuation,
    })
  }
  needsFollowUp = true
```

## 3. Model Call

The model is called with:

- normalized messages
- prepended user context
- full system prompt
- available tools
- MCP clients
- thinking/output options
- file-read state
- agent ID

```ts
// /Users/sarthakkapila/src/query.ts:659
for await (const message of deps.callModel({
  abortController,
  options: {
    maxThinkingTokens,
    tools: toolUseContext.options.tools,
    commands: toolUseContext.options.commands,
    forkNumber: toolUseContext.options.forkNumber,
    messageLogName,
    mcpClients: toolUseContext.options.mcpClients,
    ...toolUseContext.options,
  },
  messages: normalizeMessagesForAPI(
    prependUserContext(
      messagesForQuery,
      await userContext,
      {
        awaitServerToolUse: toolUseContext.options.awaitServerToolUse,
      },
      toolUseContext.options.isNonInteractiveSession,
    ),
  ),
  systemPrompt: fullSystemPrompt,
  maxOutputTokens: maxOutputTokensOverride,
  fallbackModelConfig,
  toolChoice,
  signal: abortController.signal,
  readFileState: toolUseContext.readFileState,
  agentId: toolUseContext.agentId,
})) {
```

## 4. Tool Calls

Tool calls are queued through `StreamingToolExecutor`. Completed tool results are yielded to the outer UI and stored for the next turn.

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

## 5. How It Knows It Is Done

If no follow-up is needed, it runs stop hooks. If hooks do not block, the query completes.

```ts
// /Users/sarthakkapila/src/query.ts:1267
const stopHookResult = yield* handleStopHooks(
  messagesForQuery,
  assistantMessages,
  systemPrompt,
  userContext,
  systemContext,
  toolUseContext,
  querySource,
  stopHookActive,
)

if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook_prevented' }
}
```

If stop hooks return blocking errors, those errors are added to the next model turn:

```ts
// /Users/sarthakkapila/src/query.ts:1282
if (stopHookResult.blockingErrors.length > 0) {
  const next: State = {
    messages: [
      ...messagesForQuery,
      ...assistantMessages,
      ...stopHookResult.blockingErrors,
    ],
    stopHookActive: true,
    transition: { reason: 'stop_hook_blocking' },
  }
  state = next
  continue
}
```

If tools were used, the loop starts the next turn:

```ts
// /Users/sarthakkapila/src/query.ts:1715
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  transition: { reason: 'next_turn' },
}
state = next
```

`maxTurns` is the hard cap.

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

## 6. Roblox Implication

For Roblox, the “planner” should mostly stay model-driven. The orchestration layer should provide better tools and better context:

- Studio tree snapshot before model call.
- Selection and logs before model call.
- Roblox MCP tools available as native tools.
- Strong system prompt rules for server/client boundaries.
- Tool result schemas that clearly report Studio mutations and runtime observations.

That lets the existing loop stay mostly unchanged.

