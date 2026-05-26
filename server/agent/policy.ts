import { findMatchingPlanStep } from "./plan.ts";
import type {
  AgentRun,
  AgentTool,
  ApprovedPlan,
  Conversation,
  PolicyDecision,
} from "./types.ts";

export type PolicyResult = {
  decision: PolicyDecision;
  scope: string;
  summary: string;
  reason: string;
  /**
   * Index into `conversation.approvedPlan.steps` if this assessment matched
   * an approved plan step. The runtime should mark it consumed once the
   * tool actually executes successfully.
   */
  planStepIndex?: number;
};

const label = (tool: AgentTool) => tool.name.replace("mcp__roblox_studio__", "").replaceAll("_", " ");

const planAuthorizes = (plan: ApprovedPlan | undefined, toolName: string, scope: string) =>
  findMatchingPlanStep(plan, toolName, scope);

export class PermissionPolicy {
  assess(tool: AgentTool, input: Record<string, unknown>, conversation: Conversation, run: AgentRun): PolicyResult {
    const scope = tool.scope(input);
    const summary = `${label(tool)} (${scope})`;

    if (tool.risk === "read") {
      return { decision: "allow", scope, summary, reason: "Read-only operations are allowed." };
    }
    if (run.mode === "plan") {
      // submit_plan is the only mutation-shaped tool we allow in plan mode,
      // but it is risk: "read" so we never reach this branch for it.
      return {
        decision: "deny",
        scope,
        summary,
        reason: "Plan mode is read-only. Start an execution run after the plan is approved.",
      };
    }
    const planStepIndex = planAuthorizes(conversation.approvedPlan, tool.name, scope);
    if (planStepIndex !== undefined) {
      return {
        decision: "allow",
        scope,
        summary,
        reason: "Authorized by the user-approved plan.",
        planStepIndex,
      };
    }
    if (conversation.approvedScopes.some((approved) => approved.toolName === tool.name && approved.scope === scope)) {
      return { decision: "allow", scope, summary, reason: "Covered by an approved execution scope." };
    }
    return {
      decision: "ask",
      scope,
      summary,
      reason: tool.risk === "low_mutation"
        ? "This action changes the connected place."
        : "This is a high-risk change and requires explicit approval.",
    };
  }
}
