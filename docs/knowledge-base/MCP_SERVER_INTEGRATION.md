# MCP Server Integration

This doc explains how this codebase connects to MCP servers, registers MCP tools, calls them, and feeds results back into the agent loop.

## 1. MCP Connection Types

The MCP client supports multiple transport types, including WebSocket, streamable HTTP, SDK/Claude.ai proxy, and local process-style MCP setups elsewhere in the client config path.

WebSocket connection:

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:760
const wsUrl = new URL(serverConfig.url)
if (serverConfig.authorization_token) {
  wsUrl.searchParams.set('authorization_token', serverConfig.authorization_token)
}
transport = new WebSocketClientTransport(wsUrl)
```

Streamable HTTP connection:

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:784
const authProvider = serverConfig.oauth
  ? new ClaudeAuthProvider(serverName, serverConfig.url)
  : undefined
transport = new StreamableHTTPClientTransport(
  new URL(serverConfig.url),
  {
    requestInit: {
      headers,
    },
    authProvider,
  },
)
```

Connection setup:

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:1048
await Promise.race([
  client.connect(transport),
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Connection timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  ),
])
```

The client also registers roots support so MCP servers can know the current workspace:

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:1009
client.setRequestHandler(ListRootsRequestSchema, async () => {
  return {
    roots: [
      {
        uri: `file://${getOriginalCwd()}`,
        name: basename(getOriginalCwd()),
      },
    ],
  }
})
```

## 2. MCP Tool Naming

MCP tools are exposed to the model as normal tools with a namespaced name like `mcp__server__tool`.

```ts
// /Users/sarthakkapila/src/services/mcp/mcpStringUtils.ts:50
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}
```

Permission rules use the fully qualified MCP name.

```ts
// /Users/sarthakkapila/src/services/mcp/mcpStringUtils.ts:60
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo
    ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
    : tool.name
}
```

## 3. MCP Tools Are Registered As Native Agent Tools

The MCP client calls `tools/list`, sanitizes the returned schemas, and maps each MCP tool into the codebase’s internal `Tool` interface.

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:1743
export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') return []

    if (!client.capabilities?.tools) {
      return []
    }

    const result = (await client.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )) as ListToolsResult
```

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:1765
return toolsToProcess
  .map((tool): Tool => {
    const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
    return {
      ...MCPTool,
      name: skipPrefix ? tool.name : fullyQualifiedName,
      mcpInfo: { serverName: client.name, toolName: tool.name },
      isMcp: true,
      searchHint:
        typeof tool._meta?.['anthropic/searchHint'] === 'string'
          ? tool._meta['anthropic/searchHint']
              .replace(/\s+/g, ' ')
              .trim() || undefined
          : undefined,
      alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
      async description() {
        return tool.description ?? ''
      },
      async prompt() {
        const desc = tool.description ?? ''
        return desc.length > MAX_MCP_DESCRIPTION_LENGTH
          ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
          : desc
      },
      inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
```

The base MCP tool wrapper is defined here:

```ts
// /Users/sarthakkapila/src/tools/MCPTool/MCPTool.ts:27
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  async call() {
    return {
      data: '',
    }
  },
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
```

The mapped MCP tool overrides the placeholder name, description, prompt, schema, permission behavior, and call behavior.

## 4. How The Model Decides To Call MCP Tools

From the model’s perspective, MCP tools are regular tools. The model receives tool names, descriptions, prompts, and JSON schemas in the model request. It chooses a tool by emitting a `tool_use` block with the MCP tool’s namespaced name and arguments.

Tool descriptions and search hints matter. For a Roblox MCP server, tool names and descriptions should be specific:

- `mcp__roblox_studio__read_game_tree`
- `mcp__roblox_studio__get_selection`
- `mcp__roblox_studio__insert_script`
- `mcp__roblox_studio__run_playtest`
- `mcp__roblox_studio__get_output_logs`

If a tool should always be visible, set MCP `_meta["anthropic/alwaysLoad"] = true`. Otherwise, search/deferred loading can hide less relevant tools until needed.

## 5. How MCP Tools Are Called

The MCP tool call uses the SDK client’s `callTool` method with a timeout and progress callback.

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:3070
const timeoutMs = getMcpToolTimeoutMs()
let timeoutId: NodeJS.Timeout | undefined

const result = await Promise.race([
  client.callTool(
    {
      name: tool,
      arguments: args,
      _meta: meta,
    },
    CallToolResultSchema,
    {
      signal,
      timeout: timeoutMs,
      onprogress: onProgress
        ? sdkProgress => {
            onProgress({
              type: 'mcp_progress',
              status: 'progress',
              serverName: name,
              toolName: tool,
              progress: sdkProgress.progress,
              total: sdkProgress.total,
              progressMessage: sdkProgress.message,
            })
          }
        : undefined,
    },
  ),
  timeoutPromise,
])
```

If MCP reports `isError`, it is converted into a tool-call error:

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:3124
if ('isError' in result && result.isError) {
  let errorDetails = 'Unknown error'
  ...
  throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorDetails,
```

## 6. How MCP Results Come Back

MCP results are normalized into text, structured JSON, or content arrays.

```ts
// /Users/sarthakkapila/src/services/mcp/client.ts:2662
export async function transformMCPResult(
  result: unknown,
  tool: string,
  name: string,
): Promise<TransformedMCPResult> {
  if (result && typeof result === 'object') {
    if ('toolResult' in result) {
      return {
        content: String(result.toolResult),
        type: 'toolResult',
      }
    }

    if (
      'structuredContent' in result &&
      result.structuredContent !== undefined
    ) {
      return {
        content: jsonStringify(result.structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(result.structuredContent),
      }
    }
```

Then the regular tool loop wraps the result as a `tool_result` and appends it to the next model turn.

## 7. MCP Resources

The codebase also exposes built-in tools for listing and reading MCP resources.

```ts
// /Users/sarthakkapila/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts:40
export const ListMcpResourcesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources from connected MCP servers',
```

```ts
// /Users/sarthakkapila/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:49
export const ReadMcpResourceTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  shouldDefer: true,
  name: 'ReadMcpResourceTool',
  searchHint: 'read a specific MCP resource by URI',
```

For Roblox, resources could expose read-only game snapshots such as:

- `roblox://game-tree/current`
- `roblox://selection/current`
- `roblox://logs/output`
- `roblox://script/game.ServerScriptService.Combat.DamageService`

## 8. What A Roblox MCP Server Needs To Expose

Minimum useful native tools:

- `read_game_tree`: return instance paths, class names, key properties, tags, attributes.
- `read_instance`: return one instance and children.
- `read_script_source`: return source and metadata for a Script, LocalScript, or ModuleScript.
- `write_script_source`: update source for an existing script.
- `insert_script`: create a script under a target instance.
- `get_selection`: return selected instances.
- `get_output_logs`: return Studio output, warnings, errors, stack traces.
- `run_playtest` / `stop_playtest`: control test execution.
- `get_diagnostics`: return Luau/type/lint diagnostics.

The MCP server should make tool schemas precise. The model performs much better when arguments are typed around Roblox concepts: `instancePath`, `className`, `scriptType`, `source`, `mode`, `timeoutMs`.

