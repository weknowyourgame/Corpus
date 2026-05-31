import type { AgentToolRegistry } from "./types.ts";
import type { StudioRelayFn } from "./studio-transport.ts";
import { z } from "zod";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const zodToJsonSchema = (schema: unknown): Record<string, unknown> => {
  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  } catch {
    return { type: "object" };
  }
};

export const buildMcpToolsList = (registry: AgentToolRegistry): McpToolSchema[] =>
  registry.list()
    .filter((t) => t.name.startsWith("mcp__roblox_studio__"))
    .map((t) => ({
      name: t.name.replace("mcp__roblox_studio__", ""),
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));

export class McpServer {
  constructor(
    private readonly registry: AgentToolRegistry,
    private readonly relay: StudioRelayFn,
  ) {}

  async handle(msg: JsonRpcMessage, sessionId: string): Promise<JsonRpcResponse | null> {
    if (!("id" in msg)) return null; // notification — no response
    const id = (msg.id ?? null) as string | number | null;

    try {
      switch (msg.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              serverInfo: { name: "stud", version: "0.1.0" },
              capabilities: { tools: {} },
            },
          };

        case "notifications/initialized":
          return null;

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: buildMcpToolsList(this.registry) },
          };

        case "tools/call": {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const rawName = String(params.name ?? "");
          const fullName = rawName.startsWith("mcp__roblox_studio__")
            ? rawName
            : `mcp__roblox_studio__${rawName}`;

          const tool = this.registry.get(fullName);
          if (!tool) {
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${rawName}` } };
          }

          const schema = tool.inputSchema as { parse?: (input: unknown) => Record<string, unknown> };
          const args = schema?.parse ? schema.parse(params.arguments ?? {}) : params.arguments ?? {};
          const ctrl = new AbortController();
          const opId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          const result = await tool.execute(args, {
            conversationId: `mcp:${sessionId}`,
            runId: opId,
            operationId: opId,
            studioSessionId: sessionId,
            signal: ctrl.signal,
            requestInteraction: async () => {
              throw new Error("This MCP tool requires interactive input, which is unavailable over direct MCP calls.");
            },
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            },
          };
        }

        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method ?? ""}` } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg.method === "tools/call") {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: message }], isError: true },
        };
      }
      return { jsonrpc: "2.0", id, error: { code: -32603, message } };
    }
  }
}

export const createMcpRequestHandler = (
  registry: AgentToolRegistry,
  relay: StudioRelayFn,
) => {
  const server = new McpServer(registry, relay);

  return async (
    req: { body: unknown },
    res: { json: (v: unknown) => void; status: (n: number) => { json: (v: unknown) => void; end: () => void }; end?: () => void },
    sessionId: string,
  ): Promise<void> => {
    const msg = req.body as JsonRpcMessage;
    if (!msg?.method) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const response = await server.handle(msg, sessionId);
    if (response === null) {
      res.status(204).end();
      return;
    }
    res.json(response);
  };
};
