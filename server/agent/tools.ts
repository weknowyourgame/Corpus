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
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const path = (input: Record<string, unknown>, key = "path") => String(input[key] ?? "game");
const stable = (value: unknown) => JSON.stringify(value);
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex").slice(0, 12);

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.union([
    z.string(),
    z.object({
      label: z.string(),
      value: z.string().optional(),
      imageUrl: z.string().nullable().optional(),
      description: z.string().optional(),
    }),
  ])).optional(),
  type: z.enum(["single", "multi", "text"]).default("text"),
});

const studioTools: Array<{
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  endpoint: string;
  risk: ToolRisk;
  scope: (input: Record<string, unknown>) => string;
}> = [
  {
    name: "mcp__roblox_studio__read_script",
    description: "Read source from a Roblox Studio script at a full instance path.",
    schema: z.object({ path: z.string() }),
    endpoint: "/script/get",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__write_script",
    description: "Replace source in an existing Roblox Studio script.",
    schema: z.object({ path: z.string(), source: z.string() }),
    endpoint: "/script/set",
    risk: "low_mutation",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__edit_script",
    description: "Replace an exact source snippet in an existing Roblox Studio script.",
    schema: z.object({ path: z.string(), oldCode: z.string(), newCode: z.string() }),
    endpoint: "/script/edit",
    risk: "low_mutation",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__list_children",
    description: "List children of a Roblox instance path, optionally recursively.",
    schema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
    endpoint: "/instance/children",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__get_properties",
    description: "Get supported properties for a Roblox instance path.",
    schema: z.object({ path: z.string() }),
    endpoint: "/instance/properties",
    risk: "read",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__set_property",
    description: "Set one property on a Roblox instance.",
    schema: z.object({ path: z.string(), property: z.string(), value: z.string() }),
    endpoint: "/instance/set",
    risk: "low_mutation",
    scope: (input) => `${path(input)}.${String(input.property)}`,
  },
  {
    name: "mcp__roblox_studio__create_instance",
    description: "Create a Roblox instance beneath a full parent path.",
    schema: z.object({ className: z.string(), parent: z.string(), name: z.string().optional() }),
    endpoint: "/instance/create",
    risk: "low_mutation",
    scope: (input) => `${path(input, "parent")}/${String(input.name ?? input.className)}:${String(input.className)}`,
  },
  {
    name: "mcp__roblox_studio__delete_instance",
    description: "Delete a Roblox instance and its descendants.",
    schema: z.object({ path: z.string() }),
    endpoint: "/instance/delete",
    risk: "destructive",
    scope: (input) => path(input),
  },
  {
    name: "mcp__roblox_studio__clone_instance",
    description: "Clone a Roblox instance, optionally into another parent.",
    schema: z.object({ path: z.string(), parent: z.string().optional() }),
    endpoint: "/instance/clone",
    risk: "low_mutation",
    scope: (input) => `${path(input)} -> ${path(input, "parent")}`,
  },
  {
    name: "mcp__roblox_studio__move_instance",
    description: "Move a Roblox instance to another parent.",
    schema: z.object({ path: z.string(), newParent: z.string() }),
    endpoint: "/instance/move",
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
    endpoint: "/instance/search",
    risk: "read",
    scope: (input) => path(input, "root"),
  },
  {
    name: "mcp__roblox_studio__get_selection",
    description: "Get currently selected Roblox Studio instances.",
    schema: z.object({}),
    endpoint: "/selection/get",
    risk: "read",
    scope: () => "studio.selection",
  },
  {
    name: "mcp__roblox_studio__execute_luau",
    description: "Execute Luau in Studio. This can change arbitrary game state.",
    schema: z.object({ code: z.string() }),
    endpoint: "/code/run",
    risk: "runtime_code",
    scope: () => "runtime-code",
  },
  {
    name: "mcp__roblox_studio__bulk_create",
    description: "Create several Roblox instances in one operation.",
    schema: z.object({ instances: z.array(z.object({ className: z.string(), parent: z.string(), name: z.string().optional() })) }),
    endpoint: "/instance/bulk-create",
    risk: "destructive",
    scope: (input) => `bulk-create:${stable(input.instances)}`,
  },
  {
    name: "mcp__roblox_studio__bulk_delete",
    description: "Delete several Roblox instance trees in one operation.",
    schema: z.object({ paths: z.array(z.string()) }),
    endpoint: "/instance/bulk-delete",
    risk: "destructive",
    scope: (input) => `bulk-delete:${stable(input.paths)}`,
  },
  {
    name: "mcp__roblox_studio__bulk_set_property",
    description: "Set properties on several Roblox instances in one operation.",
    schema: z.object({ operations: z.array(z.object({ path: z.string(), property: z.string(), value: z.string() })) }),
    endpoint: "/instance/bulk-set",
    risk: "destructive",
    scope: (input) => `bulk-set:${stable(input.operations)}`,
  },
];

export class RobloxStudioMcpGateway implements AgentToolRegistry {
  private readonly tools: AgentTool[];
  private readonly tracker = new ScriptRevisionTracker();

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
            const result = await this.relay(context.studioSessionId, item.endpoint, parsed, context.signal, context.operationId);
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
            // Check current source first
            const currentResult = await this.relay(context.studioSessionId, "/script/get", { path: parsed.path }, context.signal, `${context.operationId}:check`).catch(() => null);
            if (currentResult) {
              const currentSrc = typeof currentResult === "object" && currentResult !== null && "source" in currentResult
                ? String((currentResult as Record<string, unknown>).source ?? "")
                : "";
              const conflict = this.tracker.check(context.studioSessionId, parsed.path, currentSrc);
              if (conflict.conflict) {
                return { conflict: true, reason: conflict.reason, currentRevision: conflict.currentHash } as JsonValue;
              }
            }
            const result = await this.relay(context.studioSessionId, item.endpoint, parsed, context.signal, context.operationId);
            this.tracker.record(context.studioSessionId, parsed.path, parsed.source);
            globalScriptIndexer.index(context.studioSessionId, parsed.path, parsed.source);
            return { ...result as Record<string, unknown>, transactionId: context.operationId, undoWaypoint: "Stud: write_script" } as JsonValue;
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
            const currentResult = await this.relay(context.studioSessionId, "/script/get", { path: parsed.path }, context.signal, `${context.operationId}:check`).catch(() => null);
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
            const result = await this.relay(context.studioSessionId, item.endpoint, parsed, context.signal, context.operationId);
            const afterSource = beforeSource !== undefined ? beforeSource.replace(parsed.oldCode, parsed.newCode) : undefined;
            if (afterSource !== undefined) {
              this.tracker.record(context.studioSessionId, parsed.path, afterSource);
              globalScriptIndexer.index(context.studioSessionId, parsed.path, afterSource);
            }
            return {
              ...result as Record<string, unknown>,
              transactionId: context.operationId,
              undoWaypoint: "Stud: edit_script",
              beforeSource,
              afterSource,
            } as JsonValue;
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
          return this.relay(context.studioSessionId, item.endpoint, parsed, context.signal, context.operationId);
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
        "/asset/inspect",
        { assetId: input.assetId },
        context.signal,
        `${context.operationId}:inspect`,
      ),
      execute: async (input, context) => this.relay(
        context.studioSessionId,
        "/asset/insert",
        z.object({ assetId: z.number().int(), parent: z.string().default("game.Workspace"), stripScripts: z.boolean().optional() }).parse(input),
        context.signal,
        context.operationId,
      ),
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
      inputSchema: z.object({ questions: z.array(questionSchema).min(1).max(4) }),
      scope: () => "conversation",
      execute: async (input, context) => {
        const questions = z.array(questionSchema).parse(input.questions) as AgentQuestion[];
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
        const selection = await this.relay(context.studioSessionId, "/selection/get", undefined, context.signal, `${context.operationId}:sel`).catch(() => null);
        if (input.path) {
          const children = await this.relay(context.studioSessionId, "/instance/children", { path: input.path }, context.signal, `${context.operationId}:ctx`).catch(() => null);
          return asJson({ selection, instanceContext: { path: input.path, children } });
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
}
