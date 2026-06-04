import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentTool,
  ApprovedPlan,
  JsonValue,
  PlanStep,
  ProposedPlan,
  ToolExecutionContext,
} from "./types.ts";

const planStepSchema = z.object({
  index: z.number().int().min(0).default(0),
  title: z.string().min(1).max(120).default("Step"),
  description: z.string().min(1).max(800).default("No description provided."),
  toolNames: z.array(z.string().min(1)).min(1).default(["unknown"]),
  risk: z.enum(["read", "low_mutation", "destructive"]).default("read"),
  scope: z.string().min(1).default("unknown"),
  estimatedChanges: z.number().int().min(0).max(10_000).default(0),
  summary: z.string().min(1).max(280).optional(),
  toolName: z.string().min(1).optional(),
});

const tryParseJson = (val: unknown) => {
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch { return val; }
};

// Normalize a raw step entry — handles plain strings and objects missing fields.
const coerceStep = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    return {
      index: 0,
      title: raw.slice(0, 80) || "Step",
      description: raw.slice(0, 800) || "No description provided.",
      toolNames: ["unknown"],
      scope: "unknown",
      risk: "read",
      estimatedChanges: 0,
      summary: raw.slice(0, 280),
    };
  }
  if (typeof raw === "object" && raw !== null) {
    const step = { ...(raw as Record<string, unknown>) };
    if (!Array.isArray(step.toolNames)) {
      step.toolNames = typeof step.toolName === "string" ? [step.toolName] : ["unknown"];
    }
    const summary = typeof step.summary === "string" ? step.summary : undefined;
    const toolNames = Array.isArray(step.toolNames) ? step.toolNames : ["unknown"];
    if (!step.title || typeof step.title !== "string") step.title = summary ?? String(toolNames[0] ?? "Step");
    if (!step.description || typeof step.description !== "string") step.description = summary ?? String(step.title);
    if (!step.risk || typeof step.risk !== "string") step.risk = "read";
    if (typeof step.estimatedChanges !== "number") step.estimatedChanges = step.risk === "read" ? 0 : 1;
    return step;
  }
  return coerceStep(String(raw));
};

export const submitPlanSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const obj = { ...(raw as Record<string, unknown>) };

    // Parse steps if it arrived as a JSON string
    if (typeof obj.steps === "string") {
      const parsed = tryParseJson(obj.steps);
      // If it still isn't an array (bad JSON or plain text), wrap it as one step
      obj.steps = Array.isArray(parsed) ? parsed : [{ toolName: "unknown", scope: "unknown", summary: String(obj.steps).slice(0, 280) }];
    }

    // Coerce each step entry so missing fields get defaults
    if (Array.isArray(obj.steps)) {
      obj.steps = obj.steps.map(coerceStep);
    }

    // Auto-generate summary if the model forgot it
    if (!obj.summary || typeof obj.summary !== "string") {
      const steps = Array.isArray(obj.steps) ? obj.steps as Array<Record<string, unknown>> : [];
      obj.summary = steps.length > 0
        ? `Plan: ${steps.map((s) => String(s.summary ?? s.title ?? s.toolName ?? "step")).join("; ").slice(0, 200)}`
        : "Proposed plan";
    }

    return obj;
  },
  z.object({
    summary: z.string().min(1).max(2000),
    steps: z.array(planStepSchema).min(1).max(32),
  }),
);

export type SubmitPlanInput = z.infer<typeof submitPlanSchema>;

/**
 * The submit_plan tool. Plan-mode runs may call this to register a
 * structured plan that the user can then approve. The actual persistence
 * happens via `context.setProposedPlan`, which the runtime always wires
 * up; if the runtime omits it (e.g. unit tests), the tool returns a
 * structural failure so a malformed harness doesn't silently swallow plans.
 */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export function createSubmitPlanTool(): AgentTool {
  return {
    name: SUBMIT_PLAN_TOOL_NAME,
    description:
      "Record a structured plan describing the tools and scopes you intend to execute. Only valid in plan mode. Each step must include the exact tool name and the scope string the tool would produce when executed (e.g. `game.Workspace/Plot:Folder`). After this call the user can approve the plan; once approved you may rerun in execute mode and matching steps will not require per-call approval.",
    transport: "server",
    risk: "read",
    concurrency: "parallel_read",
    inputSchema: submitPlanSchema,
    scope: () => "plan.submit",
    execute: async (input, context: ToolExecutionContext): Promise<JsonValue> => {
      const parsed = submitPlanSchema.parse(input);
      const plan: ProposedPlan = {
        planId: randomUUID(),
        steps: parsed.steps.map((step, index) => ({
          ...step,
          index: step.index || index + 1,
          summary: step.summary ?? step.title,
          toolName: step.toolName ?? step.toolNames[0],
        })) as PlanStep[],
        summary: parsed.summary,
        submittedAt: new Date().toISOString(),
      };
      if (!context.setProposedPlan) {
        return {
          accepted: false,
          reason: "Runtime does not support plan capture (setProposedPlan unavailable).",
        } satisfies JsonValue;
      }
      await context.setProposedPlan(plan);
      return {
        accepted: true,
        planId: plan.planId,
        stepCount: plan.steps.length,
      } satisfies JsonValue;
    },
  };
}

/**
 * Find an unconsumed step in the approved plan that matches the requested
 * (toolName, scope). Read-class tool calls are not consulted here because
 * the policy already auto-allows them; approvedPlan is exclusively used to
 * gate mutation calls that would otherwise require explicit approval.
 *
 * Returns the index of the matching step, or undefined if none match.
 */
export function findMatchingPlanStep(plan: ApprovedPlan | undefined, toolName: string, scope: string): number | undefined {
  if (!plan) return undefined;
  for (let i = 0; i < plan.steps.length; i += 1) {
    if (plan.consumedStepIndices.includes(i)) continue;
    const step = plan.steps[i];
    const names = step.toolNames?.length ? step.toolNames : step.toolName ? [step.toolName] : [];
    if (names.includes(toolName) && step.scope === scope) return i;
  }
  return undefined;
}
