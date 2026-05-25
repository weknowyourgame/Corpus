import { z } from "zod";
import type { AgentQuestion, AgentTool, AgentToolRegistry, JsonValue, ToolExecutionContext } from "./types.ts";

type StudioRelay = (
  sessionId: string,
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
) => Promise<JsonValue>;

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.union([
    z.string(),
    z.object({
      label: z.string(),
      value: z.string().optional(),
      imageUrl: z.string().optional(),
      description: z.string().optional(),
    }),
  ])).optional(),
  type: z.enum(["single", "multi", "text"]).default("text"),
});

const studioTools: Array<{
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  path: string;
}> = [
  {
    name: "roblox_get_script",
    description: "Read source from a Roblox Studio script at a full instance path.",
    schema: z.object({ path: z.string() }),
    path: "/script/get",
  },
  {
    name: "roblox_set_script",
    description: "Replace all source in a Roblox Studio script.",
    schema: z.object({ path: z.string(), source: z.string() }),
    path: "/script/set",
  },
  {
    name: "roblox_edit_script",
    description: "Replace an exact source snippet in an existing Roblox Studio script.",
    schema: z.object({ path: z.string(), oldCode: z.string(), newCode: z.string() }),
    path: "/script/edit",
  },
  {
    name: "roblox_get_children",
    description: "List children of a Roblox instance path, optionally recursively.",
    schema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
    path: "/instance/children",
  },
  {
    name: "roblox_get_properties",
    description: "Get supported properties for a Roblox instance path.",
    schema: z.object({ path: z.string() }),
    path: "/instance/properties",
  },
  {
    name: "roblox_set_property",
    description: "Set a property on a Roblox instance path.",
    schema: z.object({ path: z.string(), property: z.string(), value: z.string() }),
    path: "/instance/set",
  },
  {
    name: "roblox_create",
    description: "Create a Roblox instance beneath a full parent path.",
    schema: z.object({ className: z.string(), parent: z.string(), name: z.string().optional() }),
    path: "/instance/create",
  },
  {
    name: "roblox_delete",
    description: "Delete a Roblox instance and its descendants.",
    schema: z.object({ path: z.string() }),
    path: "/instance/delete",
  },
  {
    name: "roblox_clone",
    description: "Clone a Roblox instance, optionally into another parent.",
    schema: z.object({ path: z.string(), parent: z.string().optional() }),
    path: "/instance/clone",
  },
  {
    name: "roblox_move",
    description: "Move a Roblox instance to another parent.",
    schema: z.object({ path: z.string(), newParent: z.string() }),
    path: "/instance/move",
  },
  {
    name: "roblox_search",
    description: "Search descendants by name or class name.",
    schema: z.object({
      root: z.string().optional(),
      name: z.string().optional(),
      className: z.string().optional(),
      limit: z.number().optional(),
    }),
    path: "/instance/search",
  },
  {
    name: "roblox_get_selection",
    description: "Get currently selected Roblox Studio instances.",
    schema: z.object({}),
    path: "/selection/get",
  },
  {
    name: "roblox_run_code",
    description: "Execute Luau in Studio. Use only when necessary because it can modify the place.",
    schema: z.object({ code: z.string() }),
    path: "/code/run",
  },
  {
    name: "roblox_bulk_create",
    description: "Create several Roblox instances in one operation.",
    schema: z.object({
      instances: z.array(z.object({ className: z.string(), parent: z.string(), name: z.string().optional() })),
    }),
    path: "/instance/bulk-create",
  },
  {
    name: "roblox_bulk_delete",
    description: "Delete several Roblox instance trees in one operation.",
    schema: z.object({ paths: z.array(z.string()) }),
    path: "/instance/bulk-delete",
  },
  {
    name: "roblox_bulk_set_property",
    description: "Set properties on several Roblox instances in one operation.",
    schema: z.object({
      operations: z.array(z.object({ path: z.string(), property: z.string(), value: z.string() })),
    }),
    path: "/instance/bulk-set",
  },
  {
    name: "roblox_insert_asset",
    description: "Insert a Roblox Creator Store asset under a parent path. Assets may contain scripts.",
    schema: z.object({ assetId: z.number(), parent: z.string().default("game.Workspace") }),
    path: "/asset/insert",
  },
];

async function searchToolbox(input: Record<string, unknown>, signal: AbortSignal) {
  const parsed = z.object({
    query: z.string(),
    category: z.enum(["Model", "Decal", "Audio", "Plugin", "MeshPart"]).default("Model"),
    limit: z.number().min(1).max(50).default(10),
  }).parse(input);
  const types = { Model: 10, Decal: 13, Audio: 3, Plugin: 38, MeshPart: 40 };
  const params = new URLSearchParams({
    Category: "1",
    Keyword: parsed.query,
    AssetType: String(types[parsed.category]),
    Limit: String(parsed.limit),
    SortType: "0",
    SortAggregation: "3",
    SortOrder: "2",
    IncludeNotForSale: "false",
  });
  const response = await fetch(`https://catalog.roblox.com/v1/search/items/details?${params}`, { signal });
  if (!response.ok) return { error: `Creator Store search failed: ${response.status}` };
  const data = await response.json() as { data?: Array<Record<string, unknown>> };
  const raw = data.data ?? [];
  const ids = raw.map((item) => Number(item.id)).filter(Number.isFinite);
  const thumbnailParams = new URLSearchParams({
    assetIds: ids.join(","),
    size: "150x150",
    format: "Png",
    isCircular: "false",
  });
  const thumbnailResponse = ids.length
    ? await fetch(`https://thumbnails.roblox.com/v1/assets?${thumbnailParams}`, { signal })
    : null;
  const thumbnails = thumbnailResponse?.ok
    ? await thumbnailResponse.json() as { data?: Array<{ targetId: number; imageUrl: string }> }
    : { data: [] };
  const byId = new Map((thumbnails.data ?? []).map((item) => [item.targetId, item.imageUrl]));
  return {
    count: raw.length,
    results: raw.map((item) => ({
      id: Number(item.id),
      name: String(item.name ?? `Asset ${item.id}`),
      creator: String(item.creatorName ?? "Unknown"),
      thumbnailUrl: byId.get(Number(item.id)) ?? null,
    })),
  };
}

export class TransitionalRobloxTools implements AgentToolRegistry {
  private readonly tools: AgentTool[];

  constructor(private readonly relay: StudioRelay) {
    this.tools = studioTools.map((item) => ({
      name: item.name,
      description: item.description,
      inputSchema: item.schema,
      execute: async (input, context) => {
        const parsed = item.schema.parse(input);
        return this.relay(context.studioSessionId, item.path, parsed, context.signal);
      },
    }));
    this.tools.push({
      name: "roblox_toolbox_search",
      description: "Search Roblox Creator Store assets and return options with thumbnail URLs.",
      inputSchema: z.object({
        query: z.string(),
        category: z.enum(["Model", "Decal", "Audio", "Plugin", "MeshPart"]).default("Model"),
        limit: z.number().min(1).max(50).default(10),
      }),
      execute: async (input, context) => asJson(await searchToolbox(input, context.signal)),
    });
    this.tools.push({
      name: "roblox_ask_user",
      description: "Ask the user one or more run-scoped questions and wait for their answer.",
      inputSchema: z.object({ questions: z.array(questionSchema).min(1).max(4) }),
      execute: async (input, context) => {
        const questions = z.array(questionSchema).parse(input.questions) as AgentQuestion[];
        const answers = await context.requestInteraction(questions);
        return asJson({
          answered: true,
          questions: questions.map((question, index) => ({ question: question.question, answer: answers[index] })),
        });
      },
    });
  }

  list() {
    return this.tools;
  }

  async execute(name: string, input: Record<string, unknown>, context: ToolExecutionContext) {
    const selected = this.tools.find((tool) => tool.name === name);
    if (!selected) return { error: `Unknown tool: ${name}` };
    try {
      return await selected.execute(input, context);
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
