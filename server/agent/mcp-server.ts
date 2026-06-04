import type { AgentTool, AgentToolRegistry, JsonValue, ToolRisk } from "./types.ts";
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

type ExternalMcpStatus = {
  name: string;
  url: string;
  connected: boolean;
  tools: string[];
  lastError?: string;
};

const safeName = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 40) || "server";

const mcpRisk = (toolName: string): ToolRisk =>
  /\b(read|get|list|search)\b/i.test(toolName) ? "read" : "low_mutation";

async function rpc(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function genericInputSchema(schema: unknown) {
  if (schema && typeof schema === "object") {
    return z.looseObject({}).describe("External MCP tool input");
  }
  return z.looseObject({});
}

export class ExternalMcpRegistry implements AgentToolRegistry {
  private readonly tools: AgentTool[] = [];
  private readonly statuses: ExternalMcpStatus[] = [];

  static async fromEnv(): Promise<ExternalMcpRegistry> {
    const registry = new ExternalMcpRegistry();
    await registry.loadFromEnv();
    return registry;
  }

  list() {
    return this.tools;
  }

  get(name: string) {
    return this.tools.find((tool) => tool.name === name);
  }

  status() {
    return { servers: this.statuses };
  }

  private async loadFromEnv() {
    const config = process.env.STUD_MCP_SERVERS ?? "";
    const entries = config.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf(":");
        if (idx === -1) return null;
        return { name: safeName(entry.slice(0, idx)), url: entry.slice(idx + 1) };
      })
      .filter((entry): entry is { name: string; url: string } => Boolean(entry?.name && entry.url));

    for (const entry of entries) {
      const status: ExternalMcpStatus = { ...entry, connected: false, tools: [] };
      this.statuses.push(status);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          await rpc(entry.url, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "stud", version: "0.1.0" } } }, controller.signal).catch(() => undefined);
          const list = await rpc(entry.url, { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }, controller.signal);
          const rawTools = ((list.result as { tools?: unknown[] } | undefined)?.tools ?? []) as Array<Record<string, unknown>>;
          for (const raw of rawTools) {
            const rawName = typeof raw.name === "string" ? raw.name : "";
            if (!rawName) continue;
            const fullName = `mcp__${entry.name}__${safeName(rawName)}`;
            status.tools.push(fullName);
            const risk = mcpRisk(rawName);
            this.tools.push({
              name: fullName,
              description: typeof raw.description === "string" ? raw.description : `External MCP tool ${rawName}`,
              transport: "server",
              risk,
              concurrency: risk === "read" ? "parallel_read" : "exclusive_mutation",
              inputSchema: genericInputSchema(raw.inputSchema),
              scope: () => `mcp:${entry.name}:${rawName}`,
              execute: async (input, context) => {
                const result = await rpc(entry.url, {
                  jsonrpc: "2.0",
                  id: context.operationId,
                  method: "tools/call",
                  params: { name: rawName, arguments: input },
                }, context.signal);
                return (result.result ?? result.error ?? {}) as JsonValue;
              },
            });
          }
          status.connected = true;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        status.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}
