import type {
  AgentRun,
  AgentTool,
  Conversation,
  PolicyDecision,
} from "./types.ts";

export type PolicyResult = {
  decision: PolicyDecision;
  scope: string;
  summary: string;
  reason: string;
};

const label = (tool: AgentTool) => tool.name.replace("mcp__roblox_studio__", "").replaceAll("_", " ");

export class PermissionPolicy {
  assess(tool: AgentTool, input: Record<string, unknown>, conversation: Conversation, run: AgentRun): PolicyResult {
    const scope = tool.scope(input);
    const summary = `${label(tool)} (${scope})`;

    if (tool.risk === "read") {
      return { decision: "allow", scope, summary, reason: "Read-only operations are allowed." };
    }
    if (run.mode === "plan") {
      return {
        decision: "deny",
        scope,
        summary,
        reason: "Plan mode is read-only. Start an execution run after reviewing the plan.",
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
