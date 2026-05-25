import { z } from "zod";
import { OpenCloudClient, redactValue } from "./open-cloud.ts";
import type { AgentTool, ApprovalDecision, DataStoreApprovalRequest, JsonValue, ToolExecutionContext } from "./types.ts";

type RequestApproval = (req: DataStoreApprovalRequest) => Promise<ApprovalDecision>;

const NOT_CONFIGURED = { error: "Open Cloud not configured. Set ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_UNIVERSE_ID on the bridge." };

const scope = (s: string | unknown, k: string | unknown) => `datastore:${String(s)}/${String(k)}`;

export function createDataStoreTools(
  client: OpenCloudClient,
  requestApproval: RequestApproval,
): AgentTool[] {
  const tools: AgentTool[] = [];

  tools.push({
    name: "roblox_datastore__list_stores",
    description: "List all DataStore names for the connected universe.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: z.object({}),
    scope: () => "datastore:list-stores",
    execute: async (_input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const stores = await client.listStores(context.signal);
      return { stores } as JsonValue;
    },
  });

  tools.push({
    name: "roblox_datastore__list_keys",
    description: "List keys in a DataStore, optionally filtered by scope.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: z.object({
      store: z.string(),
      scope: z.string().optional().default("global"),
      limit: z.number().int().min(1).max(100).optional().default(50),
    }),
    scope: (input) => `datastore:${String(input.store)}/keys`,
    execute: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = z.object({ store: z.string(), scope: z.string().default("global"), limit: z.number().default(50) }).parse(input);
      const keys = await client.listKeys(parsed.store, parsed.scope, parsed.limit, context.signal);
      return { keys } as JsonValue;
    },
  });

  tools.push({
    name: "roblox_datastore__read_key",
    description: "Read a value from a DataStore key.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: z.object({
      store: z.string(),
      scope: z.string().optional().default("global"),
      key: z.string(),
    }),
    scope: (input) => scope(input.store, input.key),
    execute: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = z.object({ store: z.string(), scope: z.string().default("global"), key: z.string() }).parse(input);
      const result = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal);
      return {
        key: parsed.key,
        value: result.value !== null ? redactValue(result.value) : null,
        version: result.version ?? null,
      } as JsonValue;
    },
  });

  const writeInputSchema = z.object({
    store: z.string(),
    scope: z.string().optional().default("global"),
    key: z.string(),
    value: z.string(),
  });

  tools.push({
    name: "roblox_datastore__write_key",
    description: "Write a value to a DataStore key. Requires approval showing old and new values.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: writeInputSchema,
    scope: (input) => scope(input.store, input.key),
    preview: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = writeInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      return {
        oldValue: existing.value !== null ? redactValue(existing.value) : null,
        newValue: redactValue(parsed.value),
      } as JsonValue;
    },
    execute: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = writeInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      const oldValue = existing.value !== null ? redactValue(existing.value) : null;
      const newValue = redactValue(parsed.value);
      const decision = await requestApproval({
        approvalId: context.operationId,
        operation: "write",
        universe: client.universeId,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        oldValue,
        newValue,
        risk: "destructive",
      });
      if (decision === "deny") return { denied: true, reason: "User denied this DataStore write." } as JsonValue;
      const result = await client.writeKey(parsed.store, parsed.scope, parsed.key, parsed.value, context.signal);
      return { ok: true, version: result.version } as JsonValue;
    },
  });

  const deleteInputSchema = z.object({
    store: z.string(),
    scope: z.string().optional().default("global"),
    key: z.string(),
  });

  tools.push({
    name: "roblox_datastore__delete_key",
    description: "Delete a DataStore key. Requires approval showing the current value.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: deleteInputSchema,
    scope: (input) => scope(input.store, input.key),
    preview: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = deleteInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      return { oldValue: existing.value !== null ? redactValue(existing.value) : null } as JsonValue;
    },
    execute: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = deleteInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      const oldValue = existing.value !== null ? redactValue(existing.value) : null;
      const decision = await requestApproval({
        approvalId: context.operationId,
        operation: "delete",
        universe: client.universeId,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        oldValue,
        newValue: null,
        risk: "destructive",
      });
      if (decision === "deny") return { denied: true, reason: "User denied this DataStore delete." } as JsonValue;
      await client.deleteKey(parsed.store, parsed.scope, parsed.key, context.signal);
      return { ok: true } as JsonValue;
    },
  });

  const incrementInputSchema = z.object({
    store: z.string(),
    scope: z.string().optional().default("global"),
    key: z.string(),
    delta: z.number(),
  });

  tools.push({
    name: "roblox_datastore__increment_key",
    description: "Increment a numeric DataStore key by a delta. Requires approval.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: incrementInputSchema,
    scope: (input) => scope(input.store, input.key),
    preview: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = incrementInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      const oldNum = existing.value !== null ? Number(existing.value) : null;
      const newNum = oldNum !== null && !Number.isNaN(oldNum) ? oldNum + parsed.delta : null;
      return {
        oldValue: existing.value !== null ? redactValue(existing.value) : null,
        newValue: newNum !== null ? String(newNum) : `(current + ${parsed.delta})`,
      } as JsonValue;
    },
    execute: async (input, context) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = incrementInputSchema.parse(input);
      const existing = await client.readKey(parsed.store, parsed.scope, parsed.key, context.signal).catch(() => ({ value: null }));
      const oldValue = existing.value !== null ? redactValue(existing.value) : null;
      const decision = await requestApproval({
        approvalId: context.operationId,
        operation: "increment",
        universe: client.universeId,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        oldValue,
        newValue: `(${oldValue ?? "?"}) + ${parsed.delta}`,
        risk: "destructive",
      });
      if (decision === "deny") return { denied: true, reason: "User denied this DataStore increment." } as JsonValue;
      const result = await client.incrementKey(parsed.store, parsed.scope, parsed.key, parsed.delta, context.signal);
      return { ok: true, value: result.value } as JsonValue;
    },
  });

  return tools;
}
