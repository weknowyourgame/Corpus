# Agent Tools and Roblox Studio Adaptation

This document inventories the agent actions exposed by this codebase and maps them to a Roblox Studio / Luau adaptation. It focuses on the tool architecture, how calls enter and leave the model loop, and what must change for Roblox creators building games inside Studio.

## Shared Tool Architecture

Every built-in action is a `Tool` object. The important fields are `name`, `inputSchema`, `prompt`, `call`, `isReadOnly`, `isConcurrencySafe`, permission metadata, and result mapping.

```ts
// Tool.ts:362-386
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  aliases?: string[]
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
```

```ts
// Tool.ts:394-456
readonly inputSchema: Input
readonly inputJSONSchema?: ToolInputJSONSchema
outputSchema?: z.ZodType<unknown>
inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
isConcurrencySafe(input: z.infer<Input>): boolean
isEnabled(): boolean
isReadOnly(input: z.infer<Input>): boolean
isDestructive?(input: z.infer<Input>): boolean
interruptBehavior?(): 'cancel' | 'block'
isSearchOrReadCommand?(input: z.infer<Input>): {
  isSearch: boolean
  isRead: boolean
  isList?: boolean
}
isOpenWorld?(input: z.infer<Input>): boolean
requiresUserInteraction?(): boolean
isMcp?: boolean
isLsp?: boolean
readonly shouldDefer?: boolean
readonly alwaysLoad?: boolean
mcpInfo?: { serverName: string; toolName: string }
readonly name: string
```

`ToolResult` can return data, extra messages, a context modifier, or MCP metadata:

```ts
// Tool.ts:321-335
export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

## How Tools Are Defined For The Model

The tool pool is assembled in `tools.ts`. The base list is the source of truth for built-in tools:

```ts
// tools.ts:193-250
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled()
      ? [getTeamCreateTool(), getTeamDeleteTool()]
      : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

`getTools()` filters by simple mode, deny rules, REPL mode, and `isEnabled()`:

```ts
// tools.ts:271-326
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    ...
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)
  ...
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

For the API, each `Tool` becomes an Anthropic tool schema via `toolToAPISchema()`:

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
  ...
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

## How The Model Decides To Call A Tool

The model receives:

1. Tool name.
2. Tool description from `tool.prompt()`.
3. JSON schema from `inputSchema` or `inputJSONSchema`.
4. System prompt guidance about tool use.
5. Tool-search/deferred-tool hints when enabled.

Then the model emits `tool_use` blocks. `query.ts` collects those blocks from assistant messages:

```ts
// query.ts:826-843
if (message.type === 'assistant') {
  assistantMessages.push(message)

  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]
  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }

  if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
    for (const toolBlock of msgToolUseBlocks) {
      streamingToolExecutor.addTool(toolBlock, message)
    }
  }
}
```

Deferred tools may require `ToolSearch` first. If the model calls a deferred tool whose schema was not sent, the runtime feeds back an error telling the model to load it:

```ts
// services/tools/toolExecution.ts:572-596
export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
): string | null {
  if (!isToolSearchEnabledOptimistic()) return null
  if (!isToolSearchToolAvailable(tools)) return null
  if (!isDeferredTool(tool)) return null
  const discovered = extractDiscoveredToolNames(messages)
  if (discovered.has(tool.name)) return null
  return (
    `\n\nThis tool's schema was not sent to the API... ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}
```

## How Results Are Fed Back Into The Loop

The runtime validates input, checks permissions/hooks, calls the tool, maps the result to a `tool_result` block, and appends it as a user message. The next loop iteration sends those user tool-result messages back to the model.

Input validation:

```ts
// services/tools/toolExecution.ts:599-679
async function checkPermissionsAndCallTool(...) {
  const parsedInput = tool.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    let errorContent = formatZodValidationError(tool.name, parsedInput.error)
    ...
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `InputValidationError: ${parsedInput.error.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }
```

Permission decision:

```ts
// services/tools/toolExecution.ts:916-931
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

Tool call:

```ts
// services/tools/toolExecution.ts:1206-1222
const result = await tool.call(
  callInput,
  {
    ...toolUseContext,
    toolUseId: toolUseID,
    userModified: permissionDecision.userModified ?? false,
  },
  canUseTool,
  assistantMessage,
  progress => {
    onToolProgress({
      toolUseID: progress.toolUseID,
      data: progress.data,
    })
  },
)
```

Result mapping:

```ts
// services/tools/toolExecution.ts:1290-1295
const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
  result.data,
  toolUseID,
)
```

Streaming tools emit completed result messages during model streaming:

```ts
// query.ts:847-861
if (
  streamingToolExecutor &&
  !toolUseContext.abortController.signal.aborted
) {
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      yield result.message
      toolResults.push(
        ...normalizeMessagesForAPI(
          [result.message],
          toolUseContext.options.tools,
        ).filter(_ => _.type === 'user'),
      )
    }
  }
}
```

## Built-In Tool Inventory

The table lists every built-in tool visible in `getAllBaseTools()` plus the built-in MCP resource tools. Conditional tools whose implementation files are not present in this checkout are listed as conditional extension points because `tools.ts` still wires them into the architecture.

| Tool / action | Definition | What it does | Model call decision | Result feedback |
|---|---:|---|---|---|
| `AgentTool` | `tools/AgentTool/AgentTool.tsx:196` | Spawns subagents/forks/teams for delegated work. | Model sees agent prompt and available agent definitions; often selected for parallel or isolated work. | Returns task/agent metadata and later task output/notifications into the loop. |
| `TaskOutputTool` | `tools/TaskOutputTool/TaskOutputTool.tsx:144` | Reads output from background/local tasks. | Model calls when it needs task results. | Output is mapped to a tool result, often with progress. |
| `BashTool` | `tools/BashTool/BashTool.tsx:420` | Runs shell commands in cwd with permission/sandbox logic. | Model sees shell command schema and prompt guidance. | stdout/stderr/status are returned as `tool_result`. |
| `PowerShellTool` | `tools/PowerShellTool/PowerShellTool.tsx:272` | Runs PowerShell commands when enabled. | Same as Bash, but Windows/PowerShell-specific prompt/schema. | command output/status as `tool_result`. |
| `GlobTool` | `tools/GlobTool/GlobTool.ts:57` | Finds files by glob pattern. | Model calls for path discovery. | Matched paths returned into context. |
| `GrepTool` | `tools/GrepTool/GrepTool.ts:160` | Searches file contents, backed by ripgrep. | Model calls for code/content search. | Matches/snippets/files returned into context. |
| `FileReadTool` | `tools/FileReadTool/FileReadTool.ts:337` | Reads files, images, notebooks, bounded by read limits. | Model calls when it needs file contents. | File content or media representation returned. |
| `FileEditTool` | `tools/FileEditTool/FileEditTool.ts:86` | Applies string-based edits to existing files. | Model calls when modifying known file content. | Diff/result message returned; file history updated. |
| `FileWriteTool` | `tools/FileWriteTool/FileWriteTool.ts:94` | Writes/creates full file content. | Model calls for new files or full rewrites. | Written path/content summary/diff returned. |
| `NotebookEditTool` | `tools/NotebookEditTool/NotebookEditTool.ts:90` | Edits Jupyter notebook cells. | Model calls for `.ipynb` cell operations. | Notebook edit result returned. |
| `ExitPlanModeV2Tool` | `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:147` | Leaves plan mode, optionally with a plan. | Model calls after planning when ready to execute. | Mode change/context update returned. |
| `EnterPlanModeTool` | `tools/EnterPlanModeTool/EnterPlanModeTool.ts:36` | Enters planning-only permission mode. | Model calls when it should plan before editing. | Permission/mode state updated. |
| `TodoWriteTool` | `tools/TodoWriteTool/TodoWriteTool.ts:31` | Updates visible todo/checklist state. | Model calls for multi-step task tracking. | Todo state returned and rendered. |
| `TaskCreateTool` | `tools/TaskCreateTool/TaskCreateTool.ts:48` | Creates a structured task record. | Model calls when todo-v2/task tracking is enabled. | Task id/state returned. |
| `TaskGetTool` | `tools/TaskGetTool/TaskGetTool.ts:38` | Reads a task by id. | Model calls when it needs current task details. | Task details returned. |
| `TaskUpdateTool` | `tools/TaskUpdateTool/TaskUpdateTool.ts:88` | Updates a task. | Model calls to mark progress/status. | Updated task returned. |
| `TaskListTool` | `tools/TaskListTool/TaskListTool.ts:33` | Lists tasks. | Model calls to inspect task state. | Task list returned. |
| `TaskStopTool` | `tools/TaskStopTool/TaskStopTool.ts:39` | Stops a running task/agent. | Model calls when cancellation is needed. | Stop result returned. |
| `AskUserQuestionTool` | `tools/AskUserQuestionTool/AskUserQuestionTool.tsx:109` | Prompts the user with structured choices. | Model calls when user input is required. | User answer returns as tool result. |
| `SendMessageTool` | `tools/SendMessageTool/SendMessageTool.ts:520` | Sends a message to a teammate/subagent. | Model calls in multi-agent/team workflows. | Delivery/status result returned. |
| `TeamCreateTool` | `tools/TeamCreateTool/TeamCreateTool.ts:74` | Creates a team/swarm of agents. | Model calls when team mode is enabled and useful. | Team metadata and spawned agents returned. |
| `TeamDeleteTool` | `tools/TeamDeleteTool/TeamDeleteTool.ts:32` | Deletes/stops a team. | Model calls to tear down teams. | Deletion status returned. |
| `EnterWorktreeTool` | `tools/EnterWorktreeTool/EnterWorktreeTool.ts:52` | Enters an isolated git worktree. | Model calls when worktree mode is enabled. | Worktree/session context changed. |
| `ExitWorktreeTool` | `tools/ExitWorktreeTool/ExitWorktreeTool.ts:148` | Leaves worktree mode. | Model calls when worktree work is done. | Original cwd/context restored. |
| `WebFetchTool` | `tools/WebFetchTool/WebFetchTool.ts:66` | Fetches and converts web pages. | Model calls for specific URLs/docs. | Page text/status returned. |
| `WebSearchTool` | `tools/WebSearchTool/WebSearchTool.ts:152` | Searches the web. | Model calls for external current info. | Search results returned. |
| `SkillTool` | `tools/SkillTool/SkillTool.ts:331` | Loads/runs local or plugin skills. | Model calls when skill prompt says to use a skill. | Expanded skill content/results returned. |
| `BriefTool` | `tools/BriefTool/BriefTool.ts:136` | Sends/records brief/status-style messages or attachments. | Model calls in brief/proactive workflows. | Brief metadata returned. |
| `ConfigTool` | `tools/ConfigTool/ConfigTool.ts:67` | Reads/updates supported settings. | Model calls for config changes when enabled. | Setting update result returned. |
| `LSPTool` | `tools/LSPTool/LSPTool.ts:127` | Queries language-server diagnostics/symbols. | Model calls when `ENABLE_LSP_TOOL` is set. | Diagnostics/symbol results returned. |
| `ListMcpResourcesTool` | `tools/ListMcpResourcesTool/ListMcpResourcesTool.ts:40` | Lists MCP server resources. | Model calls when connected MCP resources matter. | Resource list returned. |
| `ReadMcpResourceTool` | `tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:49` | Reads one MCP resource. | Model calls after listing/knowing resource URI. | Resource contents returned. |
| `McpAuthTool` | `tools/McpAuthTool/McpAuthTool.ts:63` | Authenticates a specific MCP server. | Exposed dynamically for MCP auth needs. | Auth status/elicitation returned. |
| `MCPTool` | `tools/MCPTool/MCPTool.ts:27` | Wrapper shape for dynamic MCP tools. | Dynamic MCP schemas are included as tools. | MCP response becomes tool result plus metadata. |
| `ToolSearchTool` | `tools/ToolSearchTool/ToolSearchTool.ts:304` | Finds deferred tools and makes their schemas available. | Model calls when a needed tool is deferred. | Tool references/discovered tool names enter history. |
| `CronCreateTool` | `tools/ScheduleCronTool/CronCreateTool.ts:56` | Schedules recurring/durable automation. | Model calls for reminders/recurring tasks. | Job id/schedule returned. |
| `CronDeleteTool` | `tools/ScheduleCronTool/CronDeleteTool.ts:35` | Cancels a scheduled job. | Model calls to delete automation. | Cancel status returned. |
| `CronListTool` | `tools/ScheduleCronTool/CronListTool.ts:37` | Lists scheduled jobs. | Model calls to inspect automations. | Job list returned. |
| `RemoteTriggerTool` | `tools/RemoteTriggerTool/RemoteTriggerTool.ts:46` | Triggers a remote/durable agent workflow. | Model calls when remote triggers are enabled. | Trigger status returned. |
| `SyntheticOutputTool` | `tools/SyntheticOutputTool/SyntheticOutputTool.ts:28` | Enforces structured/synthetic output. | Registered for JSON/schema output workflows. | Structured output becomes attachment/result. |
| `TestingPermissionTool` | `tools/testing/TestingPermissionTool.tsx:12` | Test-only permission tool. | Only in test environment. | Test result returned. |
| Conditional extension tools | `tools.ts:14-53`, `tools.ts:89-135` | REPL, sleep, monitor, browser, workflow, terminal capture, context inspection, history snip, notifications, PR subscription, etc. | Included only when feature flags/env vars and implementation bundles are present. | Follow same `Tool` result pathway. |
| Dynamic MCP tools | `services/mcp/*`, `tools/MCPTool/MCPTool.ts:27` | Arbitrary external tool actions from MCP servers. | Model sees server-provided name/description/schema. | MCP results are normalized as tool results with optional `_meta` and structured content. |

## Which Tools Are Software-Development Specific

These are tightly coupled to general local software development and need replacement or heavy modification for Roblox Studio:

| Current tool | Roblox status | Why |
|---|---|---|
| `FileReadTool`, `FileEditTool`, `FileWriteTool` | Replace/bridge | Roblox projects live as an Instance tree in Studio. Files may exist only if using Rojo or exported assets. |
| `GlobTool`, `GrepTool`, fuzzy file index | Replace/bridge | Searching files is not enough; must search Instances, Scripts, ModuleScripts, LocalScripts, properties, tags, and services. |
| `BashTool`, `PowerShellTool` | Modify/restrict | Shell remains useful for Rojo, Wally, git, tests, and asset pipelines, but cannot be the primary way to mutate live Studio. |
| `LSPTool` | Replace or specialize | Generic LSP may not understand live Roblox services, DataModel hierarchy, Studio diagnostics, or Luau analyzer state unless wired to Luau LSP/Rojo. |
| `NotebookEditTool` | Remove for MVP | Jupyter editing is irrelevant for Roblox creators. |
| `EnterWorktreeTool`, `ExitWorktreeTool` | Later/optional | Useful only if workflow is git/Rojo-based. Not core for Studio-first MVP. |
| `WebFetchTool`, `WebSearchTool` | Keep but tune | Useful for Roblox docs, API reference, DevForum, package docs. Needs source guidance. |
| `AgentTool`, `TodoWriteTool`, task tools | Mostly keep | Planning/delegation applies across domains. Add Roblox-specific agent prompts. |
| `MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `McpAuthTool` | Keep, crucial | Roblox Studio should be integrated through MCP/plugin tools. |
| `Cron*`, `RemoteTrigger`, notifications | Later | Useful for long-running jobs, but not needed to edit/test a Roblox game. |
| `SkillTool` | Keep | Roblox skills can teach Luau, Studio services, UI patterns, monetization, networking, etc. |

## Wrong Or Irrelevant Assumptions For Roblox

### MVP Blockers

1. **Project equals filesystem tree.** The current core assumes code is in normal files under cwd. Roblox Studio’s source of truth is often the live `DataModel` with `Script`, `LocalScript`, `ModuleScript`, `ReplicatedStorage`, `ServerScriptService`, `StarterGui`, etc.

2. **Reads/writes are path-based.** Current tools take `file_path`, globs, grep patterns, shell commands, and diffs. Studio needs stable Instance selectors: path like `game.ServerScriptService.RoundManager`, class name, unique id, source, properties, children, and ancestry.

3. **Runtime feedback comes from shell/tests.** Roblox feedback comes from Studio output, Play Solo/Start Server, client/server logs, script analysis, runtime errors, test services, and possibly microprofiler/network replication observations.

4. **Language defaults to TypeScript/JS/Python/etc.** The coding target is Luau plus Roblox APIs, client/server boundaries, replication rules, services, remotes, UI objects, assets, and permissions.

5. **Search means text search over files.** Roblox search must include tree search, source search, property search, asset references, RemoteEvents/RemoteFunctions, BindableEvents, tags/CollectionService, attributes, and UI hierarchy.

6. **Shell permissions are enough for safety.** Mutating Studio can delete Instances, publish assets, change monetization, alter DataStores, or break a live place. Permission semantics need Studio-aware destructive checks.

### Important Later

1. Git status and branch assumptions are only relevant for Rojo/git projects.
2. `CLAUDE.md` memory can stay, but Roblox projects may need `ROBLOX.md`, Rojo config, `default.project.json`, `wally.toml`, `aftman.toml`, and Studio plugin settings.
3. Generic LSP may need Luau-specific diagnostics and Roblox API metadata.
4. File attachments/image/PDF behavior is less central than Studio hierarchy snapshots and selected Instance context.
5. Worktrees and PR workflows are helpful for teams but not required for a creator working inside Studio.

## What A Roblox Studio Plugin/MCP Must Replace

For MVP, the Studio connection should become the primary project I/O layer. It should replace file-first tools with Roblox-aware tools while still fitting the existing `Tool` interface.

### Replace Reads

Current: `FileReadTool`, `GlobTool`, `GrepTool`, git status, cwd memory.

Roblox MCP/plugin should provide:

| New tool | Purpose |
|---|---|
| `roblox_get_game_tree` | Return services/children hierarchy with class names, script flags, selected depth, counts. |
| `roblox_get_selection` | Return currently selected Instances in Studio. |
| `roblox_read_instance` | Read one Instance’s class, path, properties, attributes, tags, children summary. |
| `roblox_read_script_source` | Read `Script`/`LocalScript`/`ModuleScript.Source`. |
| `roblox_search_instances` | Search by name, class, service, tag, attribute, property, path. |
| `roblox_search_script_source` | Search Luau source across scripts/modules. |
| `roblox_get_dependencies` | For a script/module, list `require` targets, remotes, services touched. |

### Replace Writes

Current: `FileEditTool`, `FileWriteTool`, shell edits.

Roblox MCP/plugin should provide:

| New tool | Purpose |
|---|---|
| `roblox_insert_script` | Create Script/LocalScript/ModuleScript under a target Instance with source. |
| `roblox_update_script_source` | Replace or patch source for an existing script. |
| `roblox_create_instance` | Insert arbitrary Instances with class, name, parent, properties. |
| `roblox_update_instance_properties` | Change properties/attributes/tags safely. |
| `roblox_move_instance` | Reparent/reorder Instances. |
| `roblox_delete_instance` | Destructive delete with confirmation/undo metadata. |
| `roblox_apply_patch_plan` | Apply multiple Studio mutations transactionally where possible. |

### Replace Run/Test/Observe

Current: shell command + test runner assumptions.

Roblox MCP/plugin should provide:

| New tool | Purpose |
|---|---|
| `roblox_run_playtest` | Start Play Solo or server/client test. |
| `roblox_stop_playtest` | Stop current simulation. |
| `roblox_get_output` | Read Studio Output logs/errors/warnings since timestamp. |
| `roblox_get_script_analysis` | Return Luau diagnostics and type errors. |
| `roblox_run_test_service` | Run TestService tests or configured test framework. |
| `roblox_invoke_command_bar` | Optional controlled command execution for advanced workflows. |
| `roblox_observe_runtime_state` | Query selected runtime values, player count, replication objects, UI visibility, etc. |

## New Prompt/Context Inputs For Roblox

The system prompt and user context should add Roblox-specific context before the first model call:

1. Current place name/id if available.
2. Studio mode: edit, play solo, server, client.
3. Selected Instances.
4. Compact game tree summary.
5. Rojo status if project is file-backed.
6. Luau diagnostics summary.
7. Recent Output errors/warnings.
8. Roblox service conventions and client/server warning.
9. Permission guidance for destructive Studio mutations.

The equivalent of `getUserContext()` should include current date plus Studio context. The equivalent of `getSystemContext()` should include either git/Rojo state or say the source of truth is live Studio.

## What Can Stay Mostly Unchanged

1. **Agent loop (`query.ts`)**: It already handles tool calls, results, retries, compaction, and follow-up turns generically.
2. **Tool interface (`Tool.ts`)**: Perfectly adequate for Roblox tools.
3. **Tool schema conversion (`utils/api.ts:toolToAPISchema`)**: Works for MCP/plugin tools.
4. **Permission pipeline (`services/tools/toolExecution.ts`)**: Keep it, add Roblox-aware permission classes.
5. **MCP architecture**: Best integration point for Studio plugin.
6. **Context compaction**: Still needed for large games and long playtest logs.
7. **Web docs tools**: Useful for Roblox Creator Hub and API reference.
8. **Todo/task/planning tools**: Domain-independent.
9. **Subagents**: Useful later for code review, UI, monetization, performance, networking, and test-focused agents.

## What Needs Complete Rewrite Or Heavy Replacement

### Complete Rewrite For MVP

1. Project I/O: replace file-path-only read/write/search with Studio DataModel tools.
2. Run/verify loop: replace shell test assumptions with Studio playtest, Output logs, Luau diagnostics, and TestService.
3. Prompt domain assumptions: make Luau/Roblox APIs the default, not general software engineering.
4. Permission model: add Studio-aware destructive operations and safe preview/undo flows.

### Heavy Modification

1. File history/diffs: support script-source diffs and Instance-tree diffs, not just filesystem diffs.
2. Search/indexing: add Instance tree and script-source indexes.
3. Attachments/context: include selected Instance and recent Studio logs.
4. LSP diagnostics: wire to Luau analyzer/Studio diagnostics.

### Can Be Deferred

1. Worktree mode.
2. Cron/remote automations.
3. Multi-agent teams.
4. Publishing/deployment tools.
5. Asset upload/marketplace integrations.
6. DataStore inspection/migration tooling.

## MVP Priority Plan

### P0: Blocks A Working Roblox MVP

1. Build a Roblox Studio plugin or MCP server exposing game-tree read, script-source read, source update, instance create/update/delete, playtest, output logs, and diagnostics.
2. Register those Studio tools as MCP tools so the existing model/tool loop can call them without changing `query.ts`.
3. Replace default file-first prompt language with Roblox-first guidance: Luau, services, client/server, remotes, replication, Studio hierarchy.
4. Add Studio context injection: current selection, tree summary, diagnostics, recent Output.
5. Restrict `Bash/FileEdit/FileWrite` as primary tools unless the project is detected as Rojo-backed.

### P1: Needed For A Good MVP

1. Add Studio-aware permission prompts for destructive Instance changes and playtest side effects.
2. Add script/Instance diff summaries so users can review changes.
3. Add search tools for Instances, scripts, properties, tags, and remotes.
4. Add a Roblox-specific verification loop: edit → run playtest → observe logs → fix.
5. Add Rojo bridge mode: if `default.project.json` exists, sync file changes and Studio tree changes coherently.

### P2: Later Quality And Scale

1. Luau LSP integration with Roblox API metadata.
2. Runtime inspection tools for UI state, replicated objects, server/client logs split.
3. Asset pipeline tools for meshes, images, animations, sounds.
4. DataStore-safe tools with explicit sandboxing.
5. Specialized Roblox agents: gameplay systems, UI, monetization, performance, networking, security review.
6. Publish/version-control workflows for team production.

## Recommended Roblox Tool Set For First Integration

Start with these MCP tools:

```text
roblox_get_game_tree
roblox_get_selection
roblox_read_instance
roblox_read_script_source
roblox_search_instances
roblox_search_script_source
roblox_insert_script
roblox_update_script_source
roblox_create_instance
roblox_update_instance_properties
roblox_delete_instance
roblox_run_playtest
roblox_stop_playtest
roblox_get_output
roblox_get_script_analysis
```

That set lets the existing architecture complete the core loop:

```text
User asks for game change
→ context includes Studio selection/tree/logs
→ model calls Roblox read/search tools
→ model calls Roblox write tools
→ model runs playtest/diagnostics
→ results return as tool_result messages
→ model fixes or explains outcome
```

The main engineering win is that the agent loop does not need to become Roblox-specific. The project-access tools and prompt/context defaults do.
