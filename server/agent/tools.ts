import { z } from "zod";
import { createHash } from "node:crypto";
import { ToolboxService, toolboxSearchSchema } from "./toolbox.ts";
import { ScriptRevisionTracker } from "./conflict.ts";
import { globalScriptIndexer } from "./retrieval.ts";
import { createSubmitPlanTool } from "./plan.ts";
import type {
  AgentQuestion,
  AgentTool,
  AgentToolRegistry,
  JsonValue,
  ToolExecutionContext,
  ToolRisk,
} from "./types.ts";

type StudioRelay = (
  sessionId: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const stable = (value: unknown) => JSON.stringify(value);

// Surface errors from Studio so the agent always sees them.
// The plugin may return { error: "...", success: false } for any failed operation.
// Without explicit surfacing the model sometimes misses the failure and continues.
const surfaceStudioError = (result: JsonValue, toolName?: string): JsonValue => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (r.success === false || (typeof r.error === "string" && r.error)) {
    const error = String(r.error ?? "Studio operation failed");
    // Add a type-hint for common property value mismatches
    let hint: string | undefined;
    if (toolName === "set_property" || toolName === "bulk_set_property") {
      if (error.toLowerCase().includes("expected") || error.toLowerCase().includes("got string")) {
        hint = "Property value type mismatch. For Vector3 use Vector3.new(x,y,z). For Color3 use Color3.fromRGB(r,g,b). For numbers pass plain digits. For booleans pass true/false.";
      }
    }
    if (error.includes("Instance not found") || error.includes("Parent not found")) {
      hint = "The instance path does not exist. Call list_children on the parent first to find the correct path, then retry.";
    }
    return { success: false, error, ...(hint ? { hint } : {}), _raw: r } as JsonValue;
  }
  return result;
};

// Normalize a Roblox path: bare service names like "ReplicatedStorage" become
// "game.ReplicatedStorage" so the plugin's getInstanceFromPath always gets a
// fully-qualified path starting with "game".
const normalizePath = (raw: string): string => {
  if (!raw || raw === "game") return "game";
  // Normalize separators: convert all forward slashes to dots
  const dotted = raw.replace(/\//g, ".");
  if (dotted.startsWith("game.")) return dotted;
  // Strip a leading "game" segment without a separator
  if (dotted === "game") return "game";
  return `game.${dotted}`;
};

const path = (input: Record<string, unknown>, key = "path") =>
  normalizePath(String(input[key] ?? "game"));
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex").slice(0, 12);

const normalizeBody = (body: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...body };
  for (const key of ["path", "parent", "newParent", "root"]) {
    if (typeof result[key] === "string") result[key] = normalizePath(result[key] as string);
  }
  if (Array.isArray(result.paths)) {
    result.paths = (result.paths as string[]).map(normalizePath);
  }
  if (Array.isArray(result.instances)) {
    result.instances = (result.instances as Array<Record<string, unknown>>).map((inst) => ({
      ...inst,
      parent: typeof inst.parent === "string" ? normalizePath(inst.parent) : inst.parent,
    }));
  }
  if (Array.isArray(result.operations)) {
    result.operations = (result.operations as Array<Record<string, unknown>>).map((op) => ({
      ...op,
      path: typeof op.path === "string" ? normalizePath(op.path) : op.path,
    }));
  }
  return result;
};

const tryParseJson = (val: unknown) => {
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch { return val; }
};

const questionSchema = z.object({
  question: z.string(),
  options: z.preprocess(tryParseJson, z.array(z.union([
    z.string(),
    z.object({
      label: z.string(),
      value: z.string().optional(),
      imageUrl: z.string().nullable().optional(),
      description: z.string().optional(),
    }),
  ])).optional()),
  type: z.enum(["single", "multi", "text"]).default("text"),
});

const studioTools: Array<{
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  mcpTool: string;
  risk: ToolRisk;
  scope: (input: Record<string, unknown>) => string;
}> = [
  {
    name: "mcp__roblox_studio__read_script",
    description: "Read source from a Roblox Studio script at a full instance path.",
    schema: z.object({ path: z.string() }),
    mcpTool: "read_script",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__write_script",
    description: "Replace source in an existing Roblox Studio script.",
    schema: z.object({ path: z.string(), source: z.string().default("") }),
    mcpTool: "write_script",
    risk: "low_mutation",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__edit_script",
    description: "Replace an exact source snippet in an existing Roblox Studio script.",
    schema: z.object({ path: z.string(), oldCode: z.string(), newCode: z.string() }),
    mcpTool: "edit_script",
    risk: "low_mutation",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__list_children",
    description: "List children of a Roblox instance path (e.g. \"game.Workspace\"), optionally recursively. Omit path to list root.",
    schema: z.object({ path: z.string().optional().default("game"), recursive: z.boolean().optional() }),
    mcpTool: "list_children",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__get_properties",
    description: "Get supported properties for a Roblox instance path.",
    schema: z.object({ path: z.string() }),
    mcpTool: "get_properties",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__set_property",
    description: "Set one property on a Roblox instance.",
    schema: z.object({ path: z.string(), property: z.string(), value: z.string() }),
    mcpTool: "set_property",
    risk: "low_mutation",
    scope: (input) => `${path(input)}.${String(input.property)}`,
  },
  {
    name: "mcp__roblox_studio__create_instance",
    description: "Create a Roblox instance beneath a parent. Use full paths like \"game.ReplicatedStorage\" or bare service names like \"ReplicatedStorage\" — both are accepted.",
    schema: z.object({ className: z.string(), parent: z.string(), name: z.string().optional() }),
    mcpTool: "create_instance",
    risk: "low_mutation",
    scope: (input) => `${path(input, "parent")}/*:${String(input.className)}`,
  },
  {
    name: "mcp__roblox_studio__delete_instance",
    description: "Delete a Roblox instance and its descendants.",
    schema: z.object({ path: z.string() }),
    mcpTool: "delete_instance",
    risk: "destructive",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__clone_instance",
    description: "Clone a Roblox instance, optionally into another parent.",
    schema: z.object({ path: z.string(), parent: z.string().optional() }),
    mcpTool: "clone_instance",
    risk: "low_mutation",
    scope: (input) => `${path(input)} -> ${path(input, "parent")}`,
  },
  {
    name: "mcp__roblox_studio__move_instance",
    description: "Move a Roblox instance to another parent.",
    schema: z.object({ path: z.string(), newParent: z.string() }),
    mcpTool: "move_instance",
    risk: "destructive",
    scope: (input) => `${path(input)} -> ${path(input, "newParent")}`,
  },
  {
    name: "mcp__roblox_studio__search_instances",
    description: "Search descendants by name or class name.",
    schema: z.object({
      root: z.string().optional(),
      name: z.string().optional(),
      className: z.string().optional(),
      limit: z.number().optional(),
    }),
    mcpTool: "search_instances",
    risk: "read",
    scope: (input) => path(input, "root"),
  },
  {
    name: "mcp__roblox_studio__get_selection",
    description: "Get currently selected Roblox Studio instances.",
    schema: z.object({}),
    mcpTool: "get_selection",
    risk: "read",
    scope: () => "studio.selection",
  },
  {
    name: "mcp__roblox_studio__execute_luau",
    description: "Execute Luau in Studio. This can change arbitrary game state.",
    schema: z.object({ code: z.string() }),
    mcpTool: "execute_luau",
    risk: "runtime_code",
    scope: () => "runtime-code",
  },
  {
    name: "mcp__roblox_studio__bulk_create",
    description: "Create several Roblox instances in one operation.",
    schema: z.object({ instances: z.array(z.object({ className: z.string(), parent: z.string(), name: z.string().optional() })) }),
    mcpTool: "bulk_create",
    risk: "destructive",
    scope: (input) => `bulk-create:${stable(input.instances)}`,
  },
  {
    name: "mcp__roblox_studio__bulk_delete",
    description: "Delete several Roblox instance trees in one operation.",
    schema: z.object({ paths: z.array(z.string()) }),
    mcpTool: "bulk_delete",
    risk: "destructive",
    scope: (input) => `bulk-delete:${stable(input.paths)}`,
  },
  {
    name: "mcp__roblox_studio__bulk_set_property",
    description: "Set properties on several Roblox instances in one operation.",
    schema: z.object({ operations: z.array(z.object({ path: z.string(), property: z.string(), value: z.string() })) }),
    mcpTool: "bulk_set_property",
    risk: "destructive",
    scope: (input) => `bulk-set:${stable(input.operations)}`,
  },
];

export class RobloxStudioMcpGateway implements AgentToolRegistry {
  private readonly tools: AgentTool[];
  private readonly tracker = new ScriptRevisionTracker();
  private readonly createdPathsBySession = new Map<string, Set<string>>();

  constructor(
    private readonly relay: StudioRelay,
    toolbox = new ToolboxService(),
  ) {
    this.tools = studioTools.map((item) => {
      if (item.name === "mcp__roblox_studio__read_script") {
        return {
          name: item.name,
          description: item.description,
          transport: "studio_mcp" as const,
          risk: item.risk,
          concurrency: item.risk === "read" ? "parallel_read" as const : "exclusive_mutation" as const,
          inputSchema: item.schema,
          scope: item.scope,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
            const parsed = item.schema.parse(input) as { path: string };
            parsed.path = normalizePath(parsed.path);
            const result = await this.relay(context.studioSessionId, item.mcpTool, parsed, context.signal, context.operationId);
            const src = typeof result === "object" && result !== null && !Array.isArray(result) && "source" in result
              ? String((result as Record<string, unknown>).source ?? "")
              : "";
            const revision = this.tracker.record(context.studioSessionId, parsed.path, src);
            if (src) globalScriptIndexer.index(context.studioSessionId, parsed.path, src);
            return { ...result as Record<string, unknown>, revision } as JsonValue;
          },
        };
      }
      if (item.name === "mcp__roblox_studio__write_script") {
        return {
          name: item.name,
          description: item.description,
          transport: "studio_mcp" as const,
          risk: item.risk,
          concurrency: "exclusive_mutation" as const,
          inputSchema: item.schema,
          scope: item.scope,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
            const parsed = item.schema.parse(input) as { path: string; source: string };
            parsed.path = normalizePath(parsed.path);
            // Check current source first
            const currentResult = await this.relay(context.studioSessionId, "read_script", { path: parsed.path }, context.signal, `${context.operationId}:check`).catch(() => null);
            let beforeSource = "";
            let revisionBefore: string | undefined;
            if (currentResult) {
              const currentSrc = typeof currentResult === "object" && currentResult !== null && "source" in currentResult
                ? String((currentResult as Record<string, unknown>).source ?? "")
                : "";
              beforeSource = currentSrc;
              revisionBefore = typeof currentResult === "object" && currentResult !== null && "revision" in currentResult
                ? String((currentResult as Record<string, unknown>).revision ?? "")
                : undefined;
              const conflict = this.tracker.check(context.studioSessionId, parsed.path, currentSrc);
              if (conflict.conflict) {
                return { conflict: true, reason: conflict.reason, currentRevision: conflict.currentHash } as JsonValue;
              }
            }
            const result = await this.relay(context.studioSessionId, item.mcpTool, parsed, context.signal, context.operationId);
            const errored = surfaceStudioError(result, "write_script");
            if (typeof errored === "object" && errored !== null && !Array.isArray(errored) && (errored as Record<string, unknown>).success === false) {
              return errored;
            }
            const revisionAfter = this.tracker.record(context.studioSessionId, parsed.path, parsed.source);
            globalScriptIndexer.index(context.studioSessionId, parsed.path, parsed.source);
            const created = this.consumeCreatedPath(context.studioSessionId, parsed.path);
            return {
              ...result as Record<string, unknown>,
              transactionId: context.operationId,
              undoWaypoint: "Stud: write_script",
              beforeSource: created ? "" : beforeSource,
              afterSource: parsed.source,
              revisionBefore,
              revisionAfter,
              created,
            } as JsonValue;
          },
        };
      }
      if (item.name === "mcp__roblox_studio__edit_script") {
        return {
          name: item.name,
          description: item.description,
          transport: "studio_mcp" as const,
          risk: item.risk,
          concurrency: "exclusive_mutation" as const,
          inputSchema: item.schema,
          scope: item.scope,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
            const parsed = item.schema.parse(input) as { path: string; oldCode: string; newCode: string };
            parsed.path = normalizePath(parsed.path);
            const currentResult = await this.relay(context.studioSessionId, "read_script", { path: parsed.path }, context.signal, `${context.operationId}:check`).catch(() => null);
            let beforeSource: string | undefined;
            if (currentResult) {
              beforeSource = typeof currentResult === "object" && currentResult !== null && "source" in currentResult
                ? String((currentResult as Record<string, unknown>).source ?? "")
                : undefined;
              if (beforeSource !== undefined) {
                const conflict = this.tracker.check(context.studioSessionId, parsed.path, beforeSource);
                if (conflict.conflict) {
                  return { conflict: true, reason: conflict.reason, currentRevision: conflict.currentHash } as JsonValue;
                }
              }
            }
            const result = await this.relay(context.studioSessionId, item.mcpTool, parsed, context.signal, context.operationId);
            const afterSource = beforeSource !== undefined ? beforeSource.replace(parsed.oldCode, parsed.newCode) : undefined;
            if (afterSource !== undefined) {
              const revisionAfter = this.tracker.record(context.studioSessionId, parsed.path, afterSource);
              globalScriptIndexer.index(context.studioSessionId, parsed.path, afterSource);
              return {
                ...result as Record<string, unknown>,
                transactionId: context.operationId,
                undoWaypoint: "Stud: edit_script",
                beforeSource,
                afterSource,
                revisionBefore: beforeSource ? createHash("sha256").update(beforeSource).digest("hex").slice(0, 12) : undefined,
                revisionAfter,
              } as JsonValue;
            }
            return {
              ...result as Record<string, unknown>,
              transactionId: context.operationId,
              undoWaypoint: "Stud: edit_script",
              ...(beforeSource !== undefined ? { beforeSource } : {}),
            } as unknown as JsonValue;
          },
        };
      }
      if (item.name === "mcp__roblox_studio__create_instance") {
        return {
          name: item.name,
          description: item.description,
          transport: "studio_mcp" as const,
          risk: item.risk,
          concurrency: "exclusive_mutation" as const,
          inputSchema: item.schema,
          scope: item.scope,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
            const parsed = item.schema.parse(input);
            const normalized = normalizeBody(parsed);
            const result = await this.relay(context.studioSessionId, item.mcpTool, normalized, context.signal, context.operationId);
            const errored = surfaceStudioError(result, item.mcpTool);
            if (typeof errored === "object" && errored !== null && !Array.isArray(errored) && (errored as Record<string, unknown>).success === false) {
              return errored;
            }
            const out = typeof result === "object" && result !== null && !Array.isArray(result) ? result as Record<string, unknown> : {};
            const createdPath = typeof out.path === "string" ? out.path : "";
            const className = typeof normalized.className === "string" ? normalized.className : "";
            if (createdPath && ["Script", "LocalScript", "ModuleScript"].includes(className)) {
              this.rememberCreatedPath(context.studioSessionId, createdPath);
            }
            return { ...out, transactionId: context.operationId, created: true, className } as JsonValue;
          },
        };
      }
      return {
        name: item.name,
        description: item.description,
        transport: "studio_mcp" as const,
        risk: item.risk,
        concurrency: item.risk === "read" ? "parallel_read" as const : "exclusive_mutation" as const,
        inputSchema: item.schema,
        scope: item.scope,
        execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
          const parsed = item.schema.parse(input);
          const result = await this.relay(context.studioSessionId, item.mcpTool, normalizeBody(parsed), context.signal, context.operationId);
          return surfaceStudioError(result, item.mcpTool);
        },
      };
    });
    this.tools.push({
      name: "mcp__roblox_studio__insert_asset",
      description: "Insert a chosen Creator Store asset after safety inspection. Scripts can be removed before parenting.",
      transport: "studio_mcp",
      risk: "external_asset",
      concurrency: "exclusive_mutation",
      inputSchema: z.object({
        assetId: z.number().int(),
        parent: z.string().default("game.Workspace"),
        stripScripts: z.boolean().optional(),
      }),
      scope: (input) => `asset:${String(input.assetId)} -> ${path(input, "parent")}`,
      preview: async (input, context) => this.relay(
        context.studioSessionId,
        "inspect_asset",
        { assetId: input.assetId },
        context.signal,
        `${context.operationId}:inspect`,
      ),
      execute: async (input, context) => {
        const parsed = z.object({ assetId: z.number().int(), parent: z.string().default("game.Workspace"), stripScripts: z.boolean().optional() }).parse(input);
        return this.relay(context.studioSessionId, "insert_asset", normalizeBody(parsed), context.signal, context.operationId);
      },
    });
    this.tools.push({
      name: "roblox_toolbox_search",
      description: "Search Creator Store models server-side with expansion, pagination, deduplication, and thumbnails.",
      transport: "server",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: toolboxSearchSchema,
      scope: (input) => `creator-store:${String(input.query ?? "")}`,
      execute: (input, context) => toolbox.search(input, context.signal),
    });
    this.tools.push({
      name: "roblox_ask_user",
      description: "Ask the user one or more run-scoped questions. Use returned thumbnail options from toolbox search.",
      transport: "server",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: z.object({ questions: z.preprocess(tryParseJson, z.array(questionSchema).min(1).max(4)) }),
      scope: () => "conversation",
      execute: async (input, context) => {
        const questions = z.preprocess(tryParseJson, z.array(questionSchema)).parse(input.questions) as AgentQuestion[];
        const answers = await context.requestInteraction(questions);
        return asJson({
          answered: true,
          questions: questions.map((question, index) => ({ question: question.question, answer: answers[index] })),
        });
      },
    });
    this.tools.push(createSubmitPlanTool());
    this.tools.push({
      name: "mcp__roblox_studio__get_live_context",
      description: "Get current Studio selection and live context for a specific instance path.",
      transport: "studio_mcp",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: z.object({ path: z.string().optional() }),
      scope: () => "studio.live-context",
      execute: async (input, context) => {
        const selection = await this.relay(context.studioSessionId, "get_selection", undefined, context.signal, `${context.operationId}:sel`).catch(() => null);
        if (input.path) {
          const normalizedPath = normalizePath(String(input.path));
          const children = await this.relay(context.studioSessionId, "list_children", { path: normalizedPath }, context.signal, `${context.operationId}:ctx`).catch(() => null);
          return asJson({ selection, instanceContext: { path: normalizedPath, children } });
        }
        return asJson({ selection });
      },
    });
  }

  getRelay(): StudioRelay {
    return this.relay;
  }

  list() {
    return this.tools;
  }

  get(name: string) {
    return this.tools.find((tool) => tool.name === name);
  }

  private rememberCreatedPath(sessionId: string, path: string) {
    const paths = this.createdPathsBySession.get(sessionId) ?? new Set<string>();
    paths.add(path);
    this.createdPathsBySession.set(sessionId, paths);
  }

  private consumeCreatedPath(sessionId: string, path: string) {
    const paths = this.createdPathsBySession.get(sessionId);
    if (!paths?.has(path)) return false;
    paths.delete(path);
    if (paths.size === 0) this.createdPathsBySession.delete(sessionId);
    return true;
  }
}
