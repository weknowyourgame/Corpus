# Subagents And Forked Agents

This doc explains how subagents/forked agents work and what that means for future Roblox-specialized agents.

## 1. Agent Tool Schema

Subagents are invoked through `AgentTool`.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/AgentTool.tsx:85
const inputSchema = z.object({
  prompt: z.string(),
  description: z.string(),
  subagent_type: z.string().optional(),
  model: z.string().optional(),
  run_in_background: z.boolean().optional(),
  name: z.string().optional(),
  team_name: z.string().optional(),
  mode: z.enum(['agent', 'team']).optional(),
  isolation: z.enum(['context', 'workspace']).optional(),
  cwd: z.string().optional(),
})
```

The parent model decides to call this tool the same way it calls any other tool: it emits a tool call with these arguments.

## 2. Forked Context Vs Fresh Agent Context

`AgentTool` decides whether the child should fork the current conversation context or start with a fresh agent definition.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/AgentTool.tsx:318
const isForkedAgent =
  validatedInput.subagent_type === FORKED_AGENT_SUBAGENT_TYPE
```

Forked agents inherit the parent system prompt and built-up messages:

```ts
// /Users/sarthakkapila/src/tools/AgentTool/AgentTool.tsx:494
const subagentSystemPrompt = isForkedAgent
  ? context.options.systemPrompt
  : selectedAgent.getSystemPrompt?.(agentPromptArgs) ?? ''

const forkContextMessages =
  isForkedAgent || isolationMode === 'context'
    ? await buildForkedMessages(context, currentMessages, canUseTool)
    : undefined
```

Non-forked agents get their own agent prompt:

```ts
// /Users/sarthakkapila/src/tools/AgentTool/AgentTool.tsx:503
const subagentPrompt = isForkedAgent
  ? getForkedAgentPrompt(validatedInput.prompt, validatedInput.description)
  : selectedAgent.getPrompt(agentPromptArgs)
```

## 3. Running The Agent

The tool builds `runAgentParams`, including prompt, system prompt, tools, context, cwd/worktree, and max turns.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/AgentTool.tsx:603
const runAgentParams: RunAgentArgs = {
  agentDefinition: selectedAgent,
  prompt: subagentPrompt,
  parentToolUseID: context.toolUseId,
  options: {
    ...context.options,
    forkNumber: context.options.forkNumber + 1,
    messageLogName,
    tools: agentTools,
    agents: selectedAgent.children ?? context.options.agents,
    mainLoopModel: resolvedAgentModel,
    systemPrompt: subagentSystemPrompt,
  },
  override: {
    systemPrompt: subagentSystemPrompt,
    userContext: subagentUserContext,
    systemContext: subagentSystemContext,
    availableTools: agentTools,
    forkContextMessages,
    useExactTools: isolationMode === 'context',
    cwd: validatedInput.cwd,
    worktreePath,
    worktreeBranch,
  },
```

`runAgent` creates initial messages from the fork context plus the child prompt.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/runAgent.ts:368
const initialMessages = [
  ...filteredForkContextMessages,
  createUserMessage(
    prompt,
    normalizedParentToolUseID,
    { isMeta: true },
  ),
]
```

Then it calls the same `query` loop used by the parent:

```ts
// /Users/sarthakkapila/src/tools/AgentTool/runAgent.ts:747
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,
  userContext: resolvedUserContext,
  systemContext: resolvedSystemContext,
  canUseTool,
  toolUseContext: agentToolUseContext,
  querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
})) {
```

## 4. Child Context Isolation

Subagents get a cloned/isolated tool-use context.

```ts
// /Users/sarthakkapila/src/utils/forkedAgent.ts:345
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides: SubagentContextOverrides = {},
): ToolUseContext {
  const agentId = overrides.agentId ?? randomUUID()
  const { getAppState, setAppState } = createIsolatedAppState(
    parentContext.getAppState,
    parentContext.setAppState,
    agentId,
  )
```

This allows child agents to keep separate task state, file-read state, todos, progress, and transcripts while still reporting back to the parent.

## 5. How Results Return To The Parent

Synchronous agents collect messages and finalize the last assistant text as the `AgentTool` result.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/agentToolUtils.ts:276
export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
```

```ts
// /Users/sarthakkapila/src/tools/AgentTool/agentToolUtils.ts:301
let content = lastAssistantMessage.message.content.filter(
  _ => _.type === 'text',
)
if (content.length === 0) {
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const m = agentMessages[i]!
    if (m.type !== 'assistant') continue
    const textBlocks = m.message.content.filter(_ => _.type === 'text')
    if (textBlocks.length > 0) {
      content = textBlocks
      break
    }
  }
}
```

Background agents use an async lifecycle and update task state as messages arrive.

```ts
// /Users/sarthakkapila/src/tools/AgentTool/agentToolUtils.ts:508
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
```

```ts
// /Users/sarthakkapila/src/tools/AgentTool/agentToolUtils.ts:554
for await (const message of makeStream(onCacheSafeParams)) {
  agentMessages.push(message)
  rootSetAppState(prev => {
    const t = prev.tasks[taskId]
    if (!isLocalAgentTask(t) || !t.retain) return prev
    const base = t.messages ?? []
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...t, messages: [...base, message] },
      },
    }
  })
```

## 6. Roblox-Specific Agent Types

This architecture can support specialized Roblox agents without rewriting the loop:

- Roblox debugger agent: gets logs, diagnostics, stack traces, playtest state.
- Roblox UI agent: gets `StarterGui`, ScreenGui tree, selected UI objects.
- Roblox combat agent: gets combat scripts, remotes, damage modules, server/client paths.
- Roblox networking/security agent: focuses on remotes, validation, client trust boundaries.

The important design choice is whether these agents are forked:

- Use forked/context-isolated agents when they need the parent conversation and latest Studio state.
- Use fresh agents when the task is narrow and can be solved from retrieved Roblox context plus a specialized prompt.

