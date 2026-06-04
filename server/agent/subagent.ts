import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createModelDriverFactory } from "./drivers.ts";
import type {
  AgentMessage,
  AgentTool,
  AgentToolRegistry,
  JsonValue,
  SubagentProgressEvent,
  ToolExecutionContext,
} from "./types.ts";

export type SubagentType = "explore" | "plan" | "debugger" | "ui_specialist" | "network_specialist" | "combat_specialist";

export type SubagentPlanProposal = {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
};

export type SubagentResult = {
  type: SubagentType;
  summary: string;
  findings: string[];
  mutations: Array<{ toolName: string; input: Record<string, unknown>; output: JsonValue }>;
  planProposals: SubagentPlanProposal[];
  iterations: number;
  aborted: boolean;
  timedOut?: boolean;
};

export type SubagentSpec = {
  type: SubagentType;
  systemPrompt: string;
  allowedTools: string[];
  maxIterations: number;
};

export const DEFAULT_SUBAGENT_BUDGET_MS = 60_000;

const READ_TOOLS = [
  "mcp__roblox_studio__read_script",
  "mcp__roblox_studio__list_children",
  "mcp__roblox_studio__get_properties",
  "mcp__roblox_studio__search_instances",
  "mcp__roblox_studio__get_selection",
  "mcp__roblox_studio__get_live_context",
  "roblox_toolbox_search",
];

const SPECS: Record<SubagentType, SubagentSpec> = {
  explore: {
    type: "explore",
    maxIterations: 8,
    allowedTools: READ_TOOLS,
    systemPrompt: `You are a Roblox project exploration specialist. Read hierarchy, scripts, selections, and properties. Do not mutate anything. Return concise findings with important paths and uncertainties.`,
  },
  plan: {
    type: "plan",
    maxIterations: 6,
    allowedTools: READ_TOOLS,
    systemPrompt: `You are a Roblox planning specialist. Read only what is needed, then output structured implementation steps with likely tools, risks, and scopes. Do not mutate anything.`,
  },
  debugger: {
    type: "debugger",
    maxIterations: 10,
    allowedTools: [...READ_TOOLS, "mcp__roblox_studio__execute_luau"],
    systemPrompt: `You are a Roblox debugging specialist. Read scripts, inspect hierarchy, and run diagnostic Luau only when needed. Do not write scripts or mutate instances. Return root cause, affected paths, and exact recommended fixes.`,
  },
  ui_specialist: {
    type: "ui_specialist",
    maxIterations: 10,
    allowedTools: [
      ...READ_TOOLS,
      "mcp__roblox_studio__create_instance",
      "mcp__roblox_studio__write_script",
      "mcp__roblox_studio__edit_script",
      "mcp__roblox_studio__set_property",
    ],
    systemPrompt: `You are a Roblox UI specialist. You may read broadly, and may mutate only UI-related instances: ScreenGui, Frame, TextLabel, TextButton, ImageLabel, ImageButton, UIListLayout, UIPadding, UICorner, and LocalScript under StarterGui/PlayerGui. Return mutations performed and any follow-up needed.`,
  },
  network_specialist: {
    type: "network_specialist",
    maxIterations: 10,
    allowedTools: [
      ...READ_TOOLS,
      "mcp__roblox_studio__create_instance",
      "mcp__roblox_studio__write_script",
      "mcp__roblox_studio__edit_script",
      "mcp__roblox_studio__set_property",
    ],
    systemPrompt: `You are a Roblox networking specialist. You may read broadly, and may mutate only RemoteEvent, RemoteFunction, server Scripts, and ModuleScripts in ReplicatedStorage or ServerScriptService. Focus on server validation and trust boundaries.`,
  },
  combat_specialist: {
    type: "combat_specialist",
    maxIterations: 8,
    allowedTools: READ_TOOLS,
    systemPrompt: `You are a legacy Roblox combat analysis specialist. Read combat scripts, damage modules, weapons, and RemoteEvents. Do not mutate anything. Prefer debugger or network_specialist for new work.`,
  },
};

const BLOCKED_RISKS = new Set(["low_mutation", "destructive", "runtime_code", "external_asset", "secret"]);
const UI_CLASSES = new Set(["ScreenGui", "Frame", "TextLabel", "TextButton", "ImageLabel", "ImageButton", "UIListLayout", "UIPadding", "UICorner", "LocalScript"]);
const NETWORK_CLASSES = new Set(["RemoteEvent", "RemoteFunction", "Script", "ModuleScript"]);

const inputPath = (input: Record<string, unknown>) =>
  String(input.path ?? input.parent ?? input.newParent ?? "");

export class ReadOnlyToolRegistry implements AgentToolRegistry {
  private readonly readTools: AgentTool[];
  readonly proposals: SubagentPlanProposal[] = [];

  constructor(parent: AgentToolRegistry) {
    this.readTools = parent.list()
      .filter((tool) => tool.name !== "roblox_spawn_subagent")
      .map((tool) => {
        if (!BLOCKED_RISKS.has(tool.risk)) return tool;
        return {
          ...tool,
          execute: async (input: Record<string, unknown>): Promise<JsonValue> => {
            this.proposals.push({ toolName: tool.name, input, reason: tool.description });
            return {
              denied: true,
              planProposal: true,
              reason: "Subagents cannot execute mutations. Proposal recorded for parent agent review.",
            };
          },
        };
      });
  }

  list(): AgentTool[] { return this.readTools; }
  get(name: string): AgentTool | undefined { return this.readTools.find((tool) => tool.name === name); }
}

function allowedByScope(type: SubagentType, toolName: string, input: Record<string, unknown>): boolean {
  if (type === "explore" || type === "plan") return false;
  if (type === "debugger") return toolName === "mcp__roblox_studio__execute_luau";
  const path = inputPath(input);
  const className = typeof input.className === "string" ? input.className : undefined;
  if (type === "ui_specialist") {
    if (className && !UI_CLASSES.has(className)) return false;
    return path.includes("StarterGui") || path.includes("PlayerGui") || path.includes("ScreenGui");
  }
  if (type === "network_specialist") {
    if (className && !NETWORK_CLASSES.has(className)) return false;
    return path.includes("ReplicatedStorage") || path.includes("ServerScriptService");
  }
  return false;
}

export class ScopedSubagentToolRegistry implements AgentToolRegistry {
  readonly proposals: SubagentPlanProposal[] = [];
  readonly mutations: Array<{ toolName: string; input: Record<string, unknown>; output: JsonValue }> = [];
  private readonly scopedTools: AgentTool[];

  constructor(parent: AgentToolRegistry, private readonly spec: SubagentSpec) {
    const allowed = new Set(spec.allowedTools);
    this.scopedTools = parent.list()
      .filter((tool) => tool.name !== "roblox_spawn_subagent")
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => {
        if (!BLOCKED_RISKS.has(tool.risk)) return tool;
        return {
          ...tool,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext): Promise<JsonValue> => {
            if (!allowedByScope(spec.type, tool.name, input)) {
              this.proposals.push({ toolName: tool.name, input, reason: `Outside ${spec.type} scope.` });
              return { denied: true, planProposal: true, reason: `Subagent ${spec.type} cannot execute this mutation scope.` };
            }
            const output = await tool.execute(input, context);
            this.mutations.push({ toolName: tool.name, input, output });
            return output;
          },
        };
      });
  }

  list(): AgentTool[] { return this.scopedTools; }
  get(name: string): AgentTool | undefined { return this.scopedTools.find((tool) => tool.name === name); }
}

export type SubagentRunOptions = {
  maxIterations?: number;
  budgetMs?: number;
  onProgress?: (event: SubagentProgressEvent) => Promise<void> | void;
};

export class SubagentRuntime {
  constructor(
    private readonly parentTools: AgentToolRegistry,
    private readonly defaultMaxIterations = 10,
  ) {}

  async run(
    type: SubagentType,
    task: string,
    studioSessionId: string,
    tier: "free" | "pro" | "hyper" | "super",
    signal: AbortSignal,
    options: SubagentRunOptions = {},
  ): Promise<SubagentResult> {
    const spec = SPECS[type];
    const budget = options.maxIterations ?? spec.maxIterations ?? this.defaultMaxIterations;
    const budgetMs = options.budgetMs ?? DEFAULT_SUBAGENT_BUDGET_MS;
    const scopedRegistry = new ScopedSubagentToolRegistry(this.parentTools, spec);
    const driver = createModelDriverFactory(scopedRegistry)({ tier });
    const messages: AgentMessage[] = [{ role: "user", content: task }];
    const findings: string[] = [];
    let iterations = 0;
    const subagentId = randomUUID();
    const startedAt = Date.now();
    let timedOut = false;

    const localController = new AbortController();
    const onParentAbort = () => localController.abort();
    if (signal.aborted) localController.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
    const budgetTimer = setTimeout(() => {
      timedOut = true;
      localController.abort();
    }, budgetMs);
    const effectiveSignal = localController.signal;

    const progress = async (kind: SubagentProgressEvent["kind"], message: string, iteration?: number) => {
      if (!options.onProgress) return;
      try {
        await options.onProgress({ subagentId, subagentType: type, kind, message, iteration });
      } catch {
        // Progress is best-effort.
      }
    };

    try {
      await progress("started", `Subagent ${type} started.`);
      for (let i = 1; i <= budget; i += 1) {
        if (effectiveSignal.aborted) break;
        iterations = i;
        let turnText = "";
        await progress("iteration", `Iteration ${i}`, i);
        const turn = await driver.generate({
          messages,
          signal: effectiveSignal,
          systemContext: spec.systemPrompt,
          onTextDelta: async (text) => { turnText += text; },
        }).catch((error: Error) => {
          if (effectiveSignal.aborted) return null;
          throw new Error(`Subagent ${type} iteration ${i} failed: ${error.message}`);
        });
        if (!turn) break;

        messages.push({ role: "assistant", content: turn.text || turnText, toolCalls: turn.toolCalls });
        if (turn.text) {
          findings.push(turn.text);
          await progress("finding", turn.text.length > 200 ? `${turn.text.slice(0, 200)}...` : turn.text, i);
        }
        if (!turn.toolCalls.length) break;

        for (const call of turn.toolCalls) {
          if (effectiveSignal.aborted) break;
          const tool = scopedRegistry.get(call.name);
          const ctx: ToolExecutionContext = {
            conversationId: `subagent-${type}`,
            runId: `sa-${i}`,
            operationId: `sa-${type}:${i}:${call.id}`,
            studioSessionId,
            signal: effectiveSignal,
            requestInteraction: async () => [],
          };
          const output = tool
            ? await tool.execute(call.input, ctx).catch((error: Error) => ({ error: error.message }))
            : ({ denied: true, reason: `Unknown or disallowed tool: ${call.name}` } as JsonValue);
          messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, output });
        }
      }
    } finally {
      clearTimeout(budgetTimer);
      signal.removeEventListener("abort", onParentAbort);
    }

    const aborted = effectiveSignal.aborted && !timedOut;
    const lastText = findings.at(-1) ?? "";
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const baseSummary = lastText || `${type} analysis complete (${iterations} iterations, ${elapsed}s)`;
    const summary = baseSummary.length > 800 ? `${baseSummary.slice(0, 800)}...` : baseSummary;
    await progress(timedOut || aborted ? "cancelled" : "completed", summary, iterations);

    return {
      type,
      summary,
      findings: findings.slice(-5),
      mutations: scopedRegistry.mutations,
      planProposals: scopedRegistry.proposals,
      iterations,
      aborted,
      timedOut,
    };
  }
}

export const subagentInputSchema = z.object({
  type: z.enum(["explore", "plan", "debugger", "ui_specialist", "network_specialist", "combat_specialist"]),
  task: z.string().min(1),
  tier: z.enum(["free", "pro", "hyper", "super"]).default("pro"),
  maxIterations: z.number().int().min(1).max(15).optional(),
});

export function createSubagentTool(parentTools: AgentToolRegistry): AgentTool {
  const runtime = new SubagentRuntime(parentTools);
  return {
    name: "roblox_spawn_subagent",
    description: "Spawn a focused Roblox specialist subagent. Specialists: explore, plan, debugger, ui_specialist, network_specialist. Explore/plan/debugger are read-only; UI/network specialists can perform tightly scoped mutations.",
    transport: "server",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: subagentInputSchema,
    scope: (input) => `subagent:${String(input.type)}`,
    execute: async (input, context) => {
      const parsed = subagentInputSchema.parse(input);
      const result = await runtime.run(
        parsed.type,
        parsed.task,
        context.studioSessionId,
        parsed.tier,
        context.signal,
        {
          maxIterations: parsed.maxIterations,
          onProgress: context.emitSubagentProgress
            ? (event) => context.emitSubagentProgress?.(event)
            : undefined,
        },
      );
      return result as unknown as JsonValue;
    },
  };
}
