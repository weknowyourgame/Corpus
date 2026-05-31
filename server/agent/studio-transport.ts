import type { JsonValue } from "./types.ts";

export type TransportMode = "plugin_fallback" | "unknown";

/** Maps legacy /endpoint paths (used in tools.ts) to the tool names the plugin handler table now uses */
const PATH_TO_TOOL: Record<string, string> = {
  "/ping": "ping",
  "/script/get": "read_script",
  "/script/set": "write_script",
  "/script/edit": "edit_script",
  "/instance/children": "list_children",
  "/instance/properties": "get_properties",
  "/instance/set": "set_property",
  "/instance/create": "create_instance",
  "/instance/delete": "delete_instance",
  "/instance/clone": "clone_instance",
  "/instance/move": "move_instance",
  "/instance/search": "search_instances",
  "/selection/get": "get_selection",
  "/code/run": "execute_luau",
  "/playtest/start": "start_playtest",
  "/playtest/stop": "stop_playtest",
  "/playtest/logs": "get_logs",
  "/playtest/diagnostics": "get_diagnostics",
};

export type StudioRelayFn = (
  sessionId: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

export type StudioStatus = {
  configuredTransport: "plugin";
  preferred: TransportMode;
  pluginConnected: boolean;
  mcpConnected: false;
  mcpServer?: null;
  mcpTools?: string[];
  mcpError?: null;
  lastUsedTransport?: TransportMode;
};

export class PluginRelayTransport {
  readonly mode: TransportMode = "plugin_fallback";
  lastUsed: TransportMode = "unknown";

  constructor(private readonly relay: StudioRelayFn) {}

  async request(
    sessionId: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    operationId: string,
  ): Promise<JsonValue> {
    // Convert legacy /path endpoints (from tools.ts) to tool names the plugin expects
    const resolved = tool.startsWith("/") ? (PATH_TO_TOOL[tool] ?? tool) : tool;
    const value = await this.relay(sessionId, resolved, args, signal, operationId);
    this.lastUsed = "plugin_fallback";
    return value;
  }

  toRelay(): StudioRelayFn {
    return (sessionId, tool, args, signal, operationId) =>
      this.request(sessionId, tool, args, signal, operationId);
  }
}

