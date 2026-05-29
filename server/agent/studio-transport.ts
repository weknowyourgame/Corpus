import type { JsonValue } from "./types.ts";
import type { StudioMcpClient, McpCallResult } from "./mcp-stdio.ts";

export type TransportMode = "official_mcp" | "plugin_fallback" | "unknown";

export type StudioRelayFn = (
  sessionId: string,
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

export type StudioStatus = {
  configuredTransport: "mcp" | "plugin" | "auto";
  preferred: TransportMode;
  pluginConnected: boolean;
  mcpConnected: boolean;
  mcpServer?: { name?: string; version?: string };
  mcpTools?: string[];
  mcpError?: string;
  lastUsedTransport?: TransportMode;
};

const JSON_BEGIN = "<<STUD_MCP_JSON_BEGIN>>";
const JSON_END = "<<STUD_MCP_JSON_END>>";

/**
 * Paths the official MCP transport can serve via run_code wrappers or direct tool calls.
 * Anything missing here is delegated to the plugin transport (or fails when --plugin
 * is disabled).
 */
export const MCP_SUPPORTED_PATHS = new Set([
  "/ping",
  "/code/run",
  "/script/get",
  "/script/set",
  "/script/edit",
  "/instance/children",
  "/instance/properties",
  "/instance/set",
  "/instance/create",
  "/instance/delete",
  "/instance/clone",
  "/instance/move",
  "/instance/search",
  "/instance/bulk-create",
  "/instance/bulk-delete",
  "/instance/bulk-set",
  "/selection/get",
  "/playtest/start",
  "/playtest/stop",
  "/playtest/logs",
  "/playtest/diagnostics",
]);

const escapeLuaString = (input: string) => input
  .replace(/\\/g, "\\\\")
  .replace(/\r/g, "\\r")
  .replace(/\n/g, "\\n")
  .replace(/\]/g, "]\\");

const wrapLua = (body: string) => `local HttpService = game:GetService("HttpService")
local ok, payload = pcall(function()
${body}
end)
if ok then
        print("${JSON_BEGIN}" .. HttpService:JSONEncode(payload) .. "${JSON_END}")
else
        print("${JSON_BEGIN}" .. HttpService:JSONEncode({ __error = tostring(payload) }) .. "${JSON_END}")
end`;

const buildScriptGetLua = (path: string) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local instance = findInstance("${escapeLuaString(path)}")
        if not instance then error("Instance not found: ${escapeLuaString(path)}") end
        if not instance:IsA("LuaSourceContainer") then error("Not a script") end
        local ScriptEditorService = game:GetService("ScriptEditorService")
        local source = ScriptEditorService:GetEditorSource(instance) or instance.Source
        return { path = "${escapeLuaString(path)}", source = source, className = instance.ClassName }
`);

const buildListChildrenLua = (path: string, recursive: boolean) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local function instancePath(inst)
                local parts = {}
                local current = inst
                while current and current ~= game do
                        table.insert(parts, 1, current.Name)
                        current = current.Parent
                end
                return "game" .. (#parts > 0 and "." .. table.concat(parts, ".") or "")
        end
        local root = findInstance("${escapeLuaString(path)}")
        if not root then error("Instance not found: ${escapeLuaString(path)}") end
        local result = {}
        if ${recursive ? "true" : "false"} then
                for _, child in ipairs(root:GetDescendants()) do
                        table.insert(result, { path = instancePath(child), name = child.Name, className = child.ClassName })
                end
        else
                for _, child in ipairs(root:GetChildren()) do
                        table.insert(result, { path = instancePath(child), name = child.Name, className = child.ClassName })
                end
        end
        return result
`);

const buildCreateInstanceLua = (className: string, parent: string, name?: string) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local function instancePath(inst)
                local parts = {}
                local current = inst
                while current and current ~= game do
                        table.insert(parts, 1, current.Name)
                        current = current.Parent
                end
                return "game" .. (#parts > 0 and "." .. table.concat(parts, ".") or "")
        end
        local parent = findInstance("${escapeLuaString(parent)}")
        if not parent then error("Parent not found: ${escapeLuaString(parent)}") end
        local inst = Instance.new("${escapeLuaString(className)}")
        ${name ? `inst.Name = "${escapeLuaString(name)}"` : ""}
        inst.Parent = parent
        return { path = instancePath(inst), className = inst.ClassName, name = inst.Name }
`);

const buildSelectionLua = () => wrapLua(`
        local Selection = game:GetService("Selection")
        local function instancePath(inst)
                local parts = {}
                local current = inst
                while current and current ~= game do
                        table.insert(parts, 1, current.Name)
                        current = current.Parent
                end
                return "game" .. (#parts > 0 and "." .. table.concat(parts, ".") or "")
        end
        local result = {}
        for _, inst in ipairs(Selection:Get()) do
                table.insert(result, { path = instancePath(inst), name = inst.Name, className = inst.ClassName })
        end
        return result
`);

const buildScriptSetLua = (path: string, source: string) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local instance = findInstance("${escapeLuaString(path)}")
        if not instance then error("Instance not found: ${escapeLuaString(path)}") end
        if not instance:IsA("LuaSourceContainer") then error("Not a script") end
        local ScriptEditorService = game:GetService("ScriptEditorService")
        local ChangeHistoryService = game:GetService("ChangeHistoryService")
        ChangeHistoryService:SetWaypoint("Stud: write_script via MCP")
        local newSource = "${escapeLuaString(source)}"
        ScriptEditorService:UpdateSourceAsync(instance, function() return newSource end)
        ChangeHistoryService:SetWaypoint("Stud: write_script via MCP done")
        return { path = "${escapeLuaString(path)}", undoWaypoint = "Stud: write_script via MCP" }
`);

const buildSetPropertyLua = (path: string, property: string, value: string) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local instance = findInstance("${escapeLuaString(path)}")
        if not instance then error("Instance not found: ${escapeLuaString(path)}") end
        local raw = "${escapeLuaString(value)}"
        local typed = raw
        if raw == "true" then typed = true elseif raw == "false" then typed = false elseif tonumber(raw) then typed = tonumber(raw) end
        instance["${escapeLuaString(property)}"] = typed
        return { path = "${escapeLuaString(path)}", property = "${escapeLuaString(property)}", value = raw }
`);

const buildDeleteInstanceLua = (path: string) => wrapLua(`
        local function findInstance(p)
                if p == "game" or p == "" or p == nil then return game end
                local parts = string.split(p, ".")
                if parts[1] ~= "game" then return nil end
                local current = game
                for i = 2, #parts do
                        local child = current:FindFirstChild(parts[i])
                        if not child then return nil end
                        current = child
                end
                return current
        end
        local instance = findInstance("${escapeLuaString(path)}")
        if not instance then error("Instance not found: ${escapeLuaString(path)}") end
        instance:Destroy()
        return { deleted = "${escapeLuaString(path)}" }
`);

const extractFenced = (text: string): JsonValue => {
  const start = text.indexOf(JSON_BEGIN);
  const end = text.indexOf(JSON_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Malformed MCP output: missing JSON fence in ${text.slice(0, 200)}`);
  }
  const payload = text.slice(start + JSON_BEGIN.length, end);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(payload) as JsonValue;
  } catch {
    throw new Error(`Malformed MCP output: JSON parse failed in ${payload.slice(0, 200)}`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "__error" in parsed) {
    const reason = String((parsed as { __error: unknown }).__error);
    throw new Error(`Studio Luau error via MCP: ${reason}`);
  }
  return parsed;
};

const flattenContent = (result: McpCallResult) =>
  result.content
    .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .join("");

export class PluginRelayTransport {
  readonly mode: TransportMode = "plugin_fallback";

  constructor(private readonly relay: StudioRelayFn) {}

  async request(
    sessionId: string,
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
    operationId: string,
  ): Promise<JsonValue> {
    return this.relay(sessionId, path, body, signal, operationId);
  }

  supports(_path: string) { return true; }
}

export class OfficialMcpTransport {
  readonly mode: TransportMode = "official_mcp";
  private client: StudioMcpClient | null;

  constructor(client: StudioMcpClient | null = null) {
    this.client = client;
  }

  setClient(client: StudioMcpClient | null): void {
    this.client = client;
  }

  getClient(): StudioMcpClient | null {
    return this.client;
  }

  getLastConnectError(): string | undefined {
    return this.client?.getLastConnectError();
  }

  supports(path: string) {
    return MCP_SUPPORTED_PATHS.has(path);
  }

  isReady() { return this.client?.isConnected() ?? false; }

  async request(
    _sessionId: string,
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
    _operationId: string,
  ): Promise<JsonValue> {
    if (!this.supports(path)) throw new Error(`MCP transport does not implement ${path}`);
    if (!this.client || !this.client.isConnected()) throw new Error("MCP transport is not connected");

    const data = body ?? {};
    switch (path) {
      case "/ping": {
        const tools = this.client.listTools().map((t) => t.name);
        return { ok: true, transport: "official_mcp", tools } satisfies JsonValue;
      }
      case "/code/run": {
        const code = String(data.code ?? "");
        const result = await this.client.callTool("run_code", { command: code }, signal);
        return this.normalizeRunCode(result);
      }
      case "/script/get":
        return this.runCodeWrapper(buildScriptGetLua(String(data.path ?? "")), signal);
      case "/script/set":
        return this.runCodeWrapper(buildScriptSetLua(String(data.path ?? ""), String(data.source ?? "")), signal);
      case "/script/edit": {
        // Implement script edit via getEditorSource + string.gsub.
        const editor = await this.runCodeWrapper(buildScriptGetLua(String(data.path ?? "")), signal);
        if (typeof editor !== "object" || !editor || Array.isArray(editor) || typeof editor.source !== "string") {
          throw new Error("MCP /script/edit: could not read current source");
        }
        const before = editor.source;
        const oldCode = String(data.oldCode ?? "");
        const newCode = String(data.newCode ?? "");
        if (!before.includes(oldCode)) throw new Error("Code not found in script");
        const after = before.replace(oldCode, newCode);
        const set = await this.runCodeWrapper(buildScriptSetLua(String(data.path ?? ""), after), signal);
        return { ...(set as Record<string, JsonValue>), beforeSource: before, afterSource: after } satisfies JsonValue;
      }
      case "/instance/children": {
        const recursive = Boolean(data.recursive);
        return this.runCodeWrapper(buildListChildrenLua(String(data.path ?? "game"), recursive), signal);
      }
      case "/instance/create": {
        return this.runCodeWrapper(buildCreateInstanceLua(String(data.className), String(data.parent ?? "game"), data.name ? String(data.name) : undefined), signal);
      }
      case "/instance/delete": {
        return this.runCodeWrapper(buildDeleteInstanceLua(String(data.path ?? "")), signal);
      }
      case "/instance/set": {
        return this.runCodeWrapper(buildSetPropertyLua(String(data.path ?? ""), String(data.property ?? ""), String(data.value ?? "")), signal);
      }
      case "/selection/get":
        return this.runCodeWrapper(buildSelectionLua(), signal);
      case "/playtest/start": {
        const result = await this.client.callTool("start_stop_play", { mode: "start_play" }, signal);
        const text = flattenContent(result);
        return { started: true, mode: "start_play", response: text } satisfies JsonValue;
      }
      case "/playtest/stop": {
        const result = await this.client.callTool("start_stop_play", { mode: "stop" }, signal);
        const text = flattenContent(result);
        return { stopped: true, response: text } satisfies JsonValue;
      }
      case "/playtest/logs": {
        const result = await this.client.callTool("get_console_output", {}, signal);
        return { logs: this.parseConsoleLines(result) } satisfies JsonValue;
      }
      case "/playtest/diagnostics": {
        const result = await this.client.callTool("get_console_output", {}, signal);
        const all = this.parseConsoleLines(result);
        const errors = all.filter((entry) => entry.severity === "error");
        return { diagnostics: errors } satisfies JsonValue;
      }
      default:
        throw new Error(`MCP transport does not implement ${path}`);
    }
  }

  private async runCodeWrapper(luau: string, signal: AbortSignal): Promise<JsonValue> {
    const client = this.client;
    if (!client) throw new Error("MCP transport is not connected");
    const result = await client.callTool("run_code", { command: luau }, signal);
    if (result.isError) {
      throw new Error(`MCP run_code reported an error: ${flattenContent(result).slice(0, 500)}`);
    }
    const text = flattenContent(result);
    return extractFenced(text);
  }

  private normalizeRunCode(result: McpCallResult): JsonValue {
    const text = flattenContent(result);
    // For plain run_code we don't apply the JSON fence (user code may print anything).
    if (text.includes(JSON_BEGIN) && text.includes(JSON_END)) {
      try { return extractFenced(text); } catch { /* fall through */ }
    }
    return { output: text, isError: Boolean(result.isError) } satisfies JsonValue;
  }

  private parseConsoleLines(result: McpCallResult): Array<{ message: string; severity: string; channel: string; timestamp: number }> {
    const text = flattenContent(result);
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-200)
      .map((line) => {
        const severity = /error|exception|traceback/i.test(line)
          ? "error"
          : /warn/i.test(line)
            ? "warning"
            : "info";
        return {
          message: line.slice(0, 2000),
          severity,
          channel: "output",
          timestamp: Date.now() / 1000,
        };
      });
  }
}

/**
 * Composite transport that prefers the official MCP path and falls back to the plugin
 * relay when MCP isn't connected, doesn't support the path, or throws.
 */
export class CompositeStudioTransport {
  lastUsed: TransportMode = "unknown";

  constructor(
    private readonly mcp: OfficialMcpTransport | null,
    private readonly plugin: PluginRelayTransport,
    private readonly configured: "mcp" | "plugin" | "auto",
  ) {}

  preferred(): TransportMode {
    if (this.configured === "plugin") return "plugin_fallback";
    if (this.mcp && this.mcp.isReady()) return "official_mcp";
    return "plugin_fallback";
  }

  async request(
    sessionId: string,
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
    operationId: string,
  ): Promise<JsonValue> {
    if (this.configured !== "plugin" && this.mcp && this.mcp.isReady() && this.mcp.supports(path)) {
      try {
        const value = await this.mcp.request(sessionId, path, body, signal, operationId);
        this.lastUsed = "official_mcp";
        return value;
      } catch (err) {
        if (this.configured === "mcp") {
          // Strict mode: surface error, do not silently fall back.
          this.lastUsed = "official_mcp";
          throw err;
        }
        // Auto mode: fall back to plugin.
        const value = await this.plugin.request(sessionId, path, body, signal, operationId);
        this.lastUsed = "plugin_fallback";
        return value;
      }
    }
    const value = await this.plugin.request(sessionId, path, body, signal, operationId);
    this.lastUsed = "plugin_fallback";
    return value;
  }

  toRelay(): StudioRelayFn {
    return (sessionId, path, body, signal, operationId) =>
      this.request(sessionId, path, body, signal, operationId);
  }
}

export function readConfiguredTransport(env: NodeJS.ProcessEnv): "mcp" | "plugin" | "auto" {
  const raw = (env.STUD_STUDIO_TRANSPORT ?? "").trim().toLowerCase();
  if (raw === "mcp" || raw === "official" || raw === "official_mcp") return "mcp";
  if (raw === "plugin" || raw === "polling" || raw === "plugin_fallback") return "plugin";
  return "auto";
}

export { extractFenced as __extractFencedForTests };
