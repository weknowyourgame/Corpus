import { z } from "zod";
import { OpenCloudClient, redactValue, type Environment } from "./open-cloud.ts";
import type { AgentTool, JsonValue } from "./types.ts";

const NOT_CONFIGURED: JsonValue = {
  error: "Open Cloud not configured. Set ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_UNIVERSE_ID on the bridge.",
  code: "open_cloud_not_configured",
};

const ROLLBACK_NOTE =
  "Writes overwrite the entry in place. Prior versions are only recoverable via Studio's DataStore Editor (~30 day version history). Increment results cannot be rolled back automatically — they must be balanced with a counter-increment.";

const environmentSchema = z.enum(["development", "staging", "production"]).default("development");

const scopeOf = (env: Environment, store: unknown, key: unknown) =>
  `datastore:${env}:${String(store)}/${String(key)}`;

const isProduction = (env: Environment): boolean => env === "production";

const previewBase = (
  client: OpenCloudClient,
  operation: "write" | "delete" | "increment",
  env: Environment,
  store: string,
  scope: string,
  key: string,
) => ({
  operation,
  environment: env,
  universe: client.universeId,
  store,
  scope,
  key,
  elevated: isProduction(env),
  rollback: ROLLBACK_NOTE,
});

const safeOldValue = (existing: { value: string | null }) =>
  existing.value !== null
    ? { oldValue: redactValue(existing.value), oldBytes: existing.value.length }
    : { oldValue: null, oldBytes: 0 };

export function createDataStoreTools(client: OpenCloudClient): AgentTool[] {
  const tools: AgentTool[] = [];

  tools.push({
    name: "roblox_datastore__list_stores",
    description: "List DataStore names for the connected universe. Read-only.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: z.object({}),
    scope: () => "datastore:list-stores",
    execute: async (_input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const stores = await client.listStores(ctx.signal);
      return { stores } as JsonValue;
    },
  });

  const listKeysSchema = z.object({
    store: z.string().min(1),
    scope: z.string().min(1).default("global"),
    limit: z.number().int().min(1).max(100).default(50),
  });

  tools.push({
    name: "roblox_datastore__list_keys",
    description: "List keys in a DataStore (optionally scoped). Read-only.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: listKeysSchema,
    scope: (input) => `datastore:${String(input.store)}/keys`,
    execute: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = listKeysSchema.parse(input);
      const keys = await client.listKeys(parsed.store, parsed.scope, parsed.limit, ctx.signal);
      return { keys, store: parsed.store, scope: parsed.scope } as JsonValue;
    },
  });

  const readSchema = z.object({
    store: z.string().min(1),
    scope: z.string().min(1).default("global"),
    key: z.string().min(1),
  });

  tools.push({
    name: "roblox_datastore__read_key",
    description: "Read a value from a DataStore key. Read-only; large values are redacted.",
    transport: "open_cloud",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: readSchema,
    scope: (input) => `datastore:${String(input.store)}/${String(input.key)}`,
    execute: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = readSchema.parse(input);
      const result = await client.readKey(parsed.store, parsed.scope, parsed.key, ctx.signal);
      return {
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        value: result.value !== null ? redactValue(result.value) : null,
        bytes: result.value !== null ? result.value.length : 0,
        version: result.version ?? null,
      } as JsonValue;
    },
  });

  const writeSchema = z.object({
    environment: environmentSchema,
    store: z.string().min(1),
    scope: z.string().min(1).default("global"),
    key: z.string().min(1),
    value: z.string(),
  });

  tools.push({
    name: "roblox_datastore__write_key",
    description:
      "Write a value to a DataStore key. Requires approval. Set environment to development|staging|production — production is shown as an elevated action.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: writeSchema,
    scope: (input) => {
      const env = environmentSchema.parse((input as { environment?: unknown }).environment);
      return scopeOf(env, input.store, input.key);
    },
    redactInput: (input) => {
      const parsed = writeSchema.safeParse(input);
      if (!parsed.success) return { invalid: true };
      return {
        environment: parsed.data.environment,
        store: parsed.data.store,
        scope: parsed.data.scope,
        key: parsed.data.key,
        valuePreview: redactValue(parsed.data.value),
        valueBytes: parsed.data.value.length,
      };
    },
    isElevated: (input) => {
      const parsed = writeSchema.safeParse(input);
      return parsed.success && isProduction(parsed.data.environment);
    },
    preview: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = writeSchema.parse(input);
      const existing = await client
        .readKey(parsed.store, parsed.scope, parsed.key, ctx.signal)
        .catch(() => ({ value: null }));
      return {
        ...previewBase(client, "write", parsed.environment, parsed.store, parsed.scope, parsed.key),
        ...safeOldValue(existing),
        newValue: redactValue(parsed.value),
        newBytes: parsed.value.length,
      } as JsonValue;
    },
    execute: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = writeSchema.parse(input);
      const result = await client.writeKey(parsed.store, parsed.scope, parsed.key, parsed.value, ctx.signal);
      return {
        ok: true,
        operation: "write",
        environment: parsed.environment,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        version: result.version,
        valuePreview: redactValue(parsed.value),
        valueBytes: parsed.value.length,
      } as JsonValue;
    },
  });

  const deleteSchema = z.object({
    environment: environmentSchema,
    store: z.string().min(1),
    scope: z.string().min(1).default("global"),
    key: z.string().min(1),
  });

  tools.push({
    name: "roblox_datastore__delete_key",
    description: "Delete a DataStore key. Requires approval. Production is shown as elevated.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: deleteSchema,
    scope: (input) => {
      const env = environmentSchema.parse((input as { environment?: unknown }).environment);
      return scopeOf(env, input.store, input.key);
    },
    redactInput: (input) => {
      const parsed = deleteSchema.safeParse(input);
      return parsed.success ? parsed.data : { invalid: true };
    },
    isElevated: (input) => {
      const parsed = deleteSchema.safeParse(input);
      return parsed.success && isProduction(parsed.data.environment);
    },
    preview: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = deleteSchema.parse(input);
      const existing = await client
        .readKey(parsed.store, parsed.scope, parsed.key, ctx.signal)
        .catch(() => ({ value: null }));
      return {
        ...previewBase(client, "delete", parsed.environment, parsed.store, parsed.scope, parsed.key),
        ...safeOldValue(existing),
        newValue: null,
      } as JsonValue;
    },
    execute: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = deleteSchema.parse(input);
      await client.deleteKey(parsed.store, parsed.scope, parsed.key, ctx.signal);
      return {
        ok: true,
        operation: "delete",
        environment: parsed.environment,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
      } as JsonValue;
    },
  });

  const incrementSchema = z.object({
    environment: environmentSchema,
    store: z.string().min(1),
    scope: z.string().min(1).default("global"),
    key: z.string().min(1),
    delta: z.number(),
  });

  tools.push({
    name: "roblox_datastore__increment_key",
    description: "Increment a numeric DataStore key by delta. Requires approval. Cannot be rolled back.",
    transport: "open_cloud",
    risk: "destructive",
    concurrency: "exclusive_mutation",
    inputSchema: incrementSchema,
    scope: (input) => {
      const env = environmentSchema.parse((input as { environment?: unknown }).environment);
      return scopeOf(env, input.store, input.key);
    },
    redactInput: (input) => {
      const parsed = incrementSchema.safeParse(input);
      return parsed.success ? parsed.data : { invalid: true };
    },
    isElevated: (input) => {
      const parsed = incrementSchema.safeParse(input);
      return parsed.success && isProduction(parsed.data.environment);
    },
    preview: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = incrementSchema.parse(input);
      const existing = await client
        .readKey(parsed.store, parsed.scope, parsed.key, ctx.signal)
        .catch(() => ({ value: null }));
      const oldNum = existing.value !== null ? Number(existing.value) : null;
      const projected = oldNum !== null && Number.isFinite(oldNum) ? oldNum + parsed.delta : null;
      return {
        ...previewBase(client, "increment", parsed.environment, parsed.store, parsed.scope, parsed.key),
        ...safeOldValue(existing),
        delta: parsed.delta,
        newValue: projected !== null ? String(projected) : `(current + ${parsed.delta})`,
      } as JsonValue;
    },
    execute: async (input, ctx) => {
      if (!client.configured) return NOT_CONFIGURED;
      const parsed = incrementSchema.parse(input);
      const result = await client.incrementKey(parsed.store, parsed.scope, parsed.key, parsed.delta, ctx.signal);
      return {
        ok: true,
        operation: "increment",
        environment: parsed.environment,
        store: parsed.store,
        scope: parsed.scope,
        key: parsed.key,
        delta: parsed.delta,
        value: result.value,
      } as JsonValue;
    },
  });

  return tools;
}
