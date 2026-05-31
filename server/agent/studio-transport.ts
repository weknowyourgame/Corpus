import type { JsonValue } from "./types.ts";

export type TransportMode = "plugin_fallback" | "unknown";

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
    const value = await this.relay(sessionId, tool, args, signal, operationId);
    this.lastUsed = "plugin_fallback";
    return value;
  }

  toRelay(): StudioRelayFn {
    return (sessionId, tool, args, signal, operationId) =>
      this.request(sessionId, tool, args, signal, operationId);
  }
}

