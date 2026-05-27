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

export type SubagentType = "debugger" | "ui_specialist" | "combat_specialist" | "network_specialist";

export type SubagentPlanProposal = {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
};

export type SubagentResult = {
  type: SubagentType;
  summary: string;
  findings: string[];
  planProposals: SubagentPlanProposal[];
  iterations: number;
  aborted: boolean;
  /** Set when the subagent stopped because the wall-clock budget elapsed. */
  timedOut?: boolean;
};

/** Default wall-clock budget per subagent run (ms). */
export const DEFAULT_SUBAGENT_BUDGET_MS = 60_000;

const SPECIALIST_PROMPTS: Record<SubagentType, string> = {
  debugger: `You are a Roblox debugging specialist with read-only Studio access.
Analyze scripts, read error logs, identify errors, and trace root causes.
Use mcp__roblox_studio__ read tools to inspect relevant scripts and instances.
Report: root cause, affected scripts with paths, and recommended fixes.
You cannot modify the place — mutations will be rejected. Instead, describe fixes clearly so the parent agent can implement them.`,

  ui_specialist: `You are a Roblox UI specialist with read-only Studio access.
Analyze StarterGui, ScreenGui trees, and UI scripts in StarterPlayer.
List children, read UI scripts, and inspect Frame/TextLabel/Button hierarchies.
Report: UI structure, missing elements, scripting issues, and improvement suggestions.
You cannot modify the place — describe changes for the parent agent to execute.`,

  combat_specialist: `You are a Roblox combat systems specialist with read-only Studio access.
Search for and read combat-related scripts in ServerScriptService and ReplicatedStorage.
Focus on: damage modules, weapon scripts, RemoteEvents for damage/combat, hitbox logic.
Report: combat architecture, server/client split, damage validation, balance issues, security gaps.
You cannot modify the place — describe changes for the parent agent to execute.`,

  network_specialist: `You are a Roblox networking and security specialist with read-only Studio access.
Search for and inspect RemoteEvents, RemoteFunctions, and server-side validation code.
Focus on: unsanitized client inputs, missing server-side validation, exploitable remotes.
Report: security vulnerabilities, trust boundary violations, and remediation steps.
You cannot modify the place — describe changes for the parent agent to execute.`,
};

const BLOCKED_RISKS = new Set(["low_mutation", "destructive", "runtime_code", "external_asset", "secret"]);

export class ReadOnlyToolRegistry implements AgentToolRegistry {
  private readonly readTools: AgentTool[];
  readonly proposals: SubagentPlanProposal[] = [];

  constructor(parent: AgentToolRegistry) {
    this.readTools = parent.list()
      .filter((t) => t.name !== "roblox_spawn_subagent")  // prevent recursion
      .map((tool) => {
        if (!BLOCKED_RISKS.has(tool.risk)) return tool;
        // Wrap mutation tools to record proposal and return denial
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
  get(name: string): AgentTool | undefined { return this.readTools.find((t) => t.name === name); }
}

export type SubagentRunOptions = {
  maxIterations?: number;
  /** Wall-clock budget in milliseconds. Defaults to DEFAULT_SUBAGENT_BUDGET_MS. */
  budgetMs?: number;
  /** Optional progress sink; runtime supplies this so events stream to the parent UI. */
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
    provider: "anthropic" | "openrouter" | "codex",
    model: string,
    signal: AbortSignal,
    options: SubagentRunOptions = {},
  ): Promise<SubagentResult> {
    const budget = options.maxIterations ?? this.defaultMaxIterations;
    const budgetMs = options.budgetMs ?? DEFAULT_SUBAGENT_BUDGET_MS;
    const readOnlyRegistry = new ReadOnlyToolRegistry(this.parentTools);
    const driverFactory = createModelDriverFactory(readOnlyRegistry);
    const driver = driverFactory({ provider, model });
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
        // Progress is best-effort; failing to emit must not abort the subagent.
      }
    };

    try {
      await progress("started", `Subagent ${type} started.`);
      for (let i = 1; i <= budget; i++) {
        if (effectiveSignal.aborted) break;
        iterations = i;
        let turnText = "";
        await progress("iteration", `Iteration ${i}`, i);

        const turn = await driver.generate({
          messages,
          signal: effectiveSignal,
          systemContext: SPECIALIST_PROMPTS[type],
          onTextDelta: async (t) => { turnText += t; },
        }).catch((err: Error) => {
          if (effectiveSignal.aborted) return null;
          throw new Error(`Subagent ${type} iteration ${i} failed: ${err.message}`);
        });
        if (!turn) break;

        messages.push({ role: "assistant", content: turn.text || turnText, toolCalls: turn.toolCalls });
        if (turn.text) {
          findings.push(turn.text);
          await progress("finding", turn.text.length > 200 ? `${turn.text.slice(0, 200)}…` : turn.text, i);
        }
        if (!turn.toolCalls.length) break;

        for (const call of turn.toolCalls) {
          if (effectiveSignal.aborted) break;
          const tool = readOnlyRegistry.get(call.name);
          const fakeCtx: ToolExecutionContext = {
            conversationId: `subagent-${type}`,
            runId: `sa-${i}`,
            operationId: `sa-${type}:${i}:${call.id}`,
            studioSessionId,
            signal: effectiveSignal,
            requestInteraction: async () => [],
          };
          const output = tool
            ? await tool.execute(call.input, fakeCtx).catch((err: Error) => ({ error: err.message }))
            : ({ denied: true, reason: `Unknown tool: ${call.name}` } as JsonValue);
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
    const summary = baseSummary.length > 800 ? `${baseSummary.slice(0, 800)}…` : baseSummary;
    await progress(timedOut || aborted ? "cancelled" : "completed", summary, iterations);

    return {
      type,
      summary,
      findings: findings.slice(-5),
      planProposals: readOnlyRegistry.proposals,
      iterations,
      aborted,
      timedOut,
    };
  }
}

export const subagentInputSchema = z.object({
  type: z.enum(["debugger", "ui_specialist", "combat_specialist", "network_specialist"]),
  task: z.string().min(1),
  provider: z.enum(["anthropic", "openrouter", "codex"]).default("anthropic"),
  model: z.string().default("claude-haiku-4-5-20251001"),
  maxIterations: z.number().int().min(1).max(15).default(8),
});

export function createSubagentTool(parentTools: AgentToolRegistry): AgentTool {
  const runtime = new SubagentRuntime(parentTools);
  return {
    name: "roblox_spawn_subagent",
    description: "Spawn a read-only specialist subagent to analyze a specific aspect of the Studio project. Specialists: debugger (errors/root cause), ui_specialist (StarterGui/UI), combat_specialist (damage/weapons), network_specialist (remotes/security). Mutation requests from subagents are converted into proposals returned to you.",
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
        parsed.provider,
        parsed.model,
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
