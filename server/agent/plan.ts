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
  toolName: z.string().min(1),
  scope: z.string().min(1),
  summary: z.string().min(1).max(280),
});

// Models sometimes JSON-stringify the steps array instead of sending it
// as a native array. Preprocess to handle both forms.
const parseIfString = (val: unknown) => {
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch { return val; }
};

export const submitPlanSchema = z.object({
  summary: z.string().min(1).max(2000),
  steps: z.preprocess(parseIfString, z.array(planStepSchema).min(1).max(32)),
});

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
        steps: parsed.steps as PlanStep[],
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
    if (step.toolName === toolName && step.scope === scope) return i;
  }
  return undefined;
}
