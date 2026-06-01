import { findMatchingPlanStep } from "./plan.ts";
import type {
  AgentRun,
  AgentTool,
  ApprovedPlan,
  ApprovedScope,
  Conversation,
  PolicyDecision,
  ScopeMatchStrategy,
} from "./types.ts";

export type PolicyMatchReason =
  | "exact_scope"
  | "path_prefix"
  | "parent_class"
  | "tool_family"
  | "full_access"
  | "plan";

export type PolicyResult = {
  decision: PolicyDecision;
  scope: string;
  summary: string;
  reason: string;
  /** Human-readable description of what will be remembered if user approves this scope. */
  scopeDescription?: string;
  /** Why this tool call was allowed without prompting (for audit log). */
  matchReason?: PolicyMatchReason;
  planStepIndex?: number;
};

type ScopeInfo = {
  canonicalScope: string;
  matchStrategy: ScopeMatchStrategy;
};

const label = (tool: AgentTool) => tool.name.replace("mcp__roblox_studio__", "").replaceAll("_", " ");

/**
 * Derive the canonical (broader) scope and match strategy from an exact scope
 * string. The canonical scope is what gets stored and matched against future
 * tool calls so that small variations don't trigger repeated prompts.
 *
 * - set_property  "path.Prop" → canonical="path", strategy=path_prefix
 *   Any property on the same instance matches.
 * - create_instance "parent/*:Class" → strategy=parent_class (exact match)
 *   Already stable across multiple instances of the same class/parent.
 * - bulk_create JSON → extract unique parent/*:class pairs, strategy=tool_family
 *   Future bulk creates using the same patterns match.
 * - bulk_set JSON → extract unique paths, strategy=tool_family
 *   Future bulk sets on the same instances match.
 * - everything else → exact match.
 */
export function deriveScopeInfo(toolName: string, exactScope: string): ScopeInfo {
  if (toolName === "mcp__roblox_studio__set_property") {
    const lastDot = exactScope.lastIndexOf(".");
    const basePath = lastDot > 0 ? exactScope.slice(0, lastDot) : exactScope;
    return { canonicalScope: basePath, matchStrategy: "path_prefix" };
  }

  if (toolName === "mcp__roblox_studio__bulk_create") {
    const json = exactScope.startsWith("bulk-create:") ? exactScope.slice("bulk-create:".length) : null;
    if (json) {
      try {
        const instances = JSON.parse(json) as Array<{ className: string; parent: string }>;
        const patterns = [...new Set(instances.map((i) => `${i.parent}/*:${i.className}`))].sort().join(",");
        return { canonicalScope: `bulk-create-family:${patterns}`, matchStrategy: "tool_family" };
      } catch { /* fall through to exact */ }
    }
  }

  if (toolName === "mcp__roblox_studio__bulk_set_property") {
    const json = exactScope.startsWith("bulk-set:") ? exactScope.slice("bulk-set:".length) : null;
    if (json) {
      try {
        const ops = JSON.parse(json) as Array<{ path: string }>;
        const paths = [...new Set(ops.map((op) => op.path))].sort().join(",");
        return { canonicalScope: `bulk-set-paths:${paths}`, matchStrategy: "tool_family" };
      } catch { /* fall through to exact */ }
    }
  }

  if (toolName === "mcp__roblox_studio__create_instance") {
    return { canonicalScope: exactScope, matchStrategy: "parent_class" };
  }

  return { canonicalScope: exactScope, matchStrategy: "exact" };
}

/**
 * Generate a human-readable description of what the "Approve this scope"
 * button will remember, so the user knows what they're committing to.
 */
export function scopeApprovalDescription(toolName: string, exactScope: string): string {
  if (toolName === "mcp__roblox_studio__set_property") {
    const lastDot = exactScope.lastIndexOf(".");
    const basePath = lastDot > 0 ? exactScope.slice(0, lastDot) : exactScope;
    return `Any property on ${basePath}`;
  }
  if (toolName === "mcp__roblox_studio__create_instance") {
    // scope = "parent/*:Class"
    const match = /^(.+)\/\*:(.+)$/.exec(exactScope);
    if (match) return `Any ${match[2]} under ${match[1]}`;
    return exactScope;
  }
  if (toolName === "mcp__roblox_studio__write_script" || toolName === "mcp__roblox_studio__edit_script") {
    return `Future edits to ${exactScope}`;
  }
  if (toolName === "mcp__roblox_studio__bulk_create") {
    return `Bulk creates with the same parent/class pattern`;
  }
  if (toolName === "mcp__roblox_studio__bulk_set_property") {
    return `Bulk property sets on the same instances`;
  }
  return exactScope;
}

/**
 * Check whether an approved scope covers the current tool request.
 * Returns the matched strategy name, or false when there is no match.
 * Handles old ApprovedScope records that predate matchStrategy/canonicalScope.
 */
function scopeCoversRequest(
  approved: ApprovedScope,
  toolName: string,
  exactScope: string,
): ScopeMatchStrategy | false {
  if (approved.toolName !== toolName) return false;

  // Backward compat: old records may lack matchStrategy/canonicalScope
  const storedStrategy: ScopeMatchStrategy = approved.matchStrategy ?? "exact";
  const storedCanonical = approved.canonicalScope ?? approved.scope;

  const { canonicalScope: candidate } = deriveScopeInfo(toolName, exactScope);

  switch (storedStrategy) {
    case "path_prefix":
      // Both canonicalScopes are the base path (property stripped). Exact match.
      return storedCanonical === candidate ? "path_prefix" : false;

    case "tool_family": {
      // bulk_create: every requested pattern must be in the approved set
      if (storedCanonical.startsWith("bulk-create-family:") && candidate.startsWith("bulk-create-family:")) {
        const approvedSet = new Set(
          storedCanonical.slice("bulk-create-family:".length).split(",").filter(Boolean),
        );
        const reqPatterns = candidate.slice("bulk-create-family:".length).split(",").filter(Boolean);
        return reqPatterns.length > 0 && reqPatterns.every((p) => approvedSet.has(p)) ? "tool_family" : false;
      }
      // bulk_set: every requested path must be in the approved set
      if (storedCanonical.startsWith("bulk-set-paths:") && candidate.startsWith("bulk-set-paths:")) {
        const approvedSet = new Set(
          storedCanonical.slice("bulk-set-paths:".length).split(",").filter(Boolean),
        );
        const reqPaths = candidate.slice("bulk-set-paths:".length).split(",").filter(Boolean);
        return reqPaths.length > 0 && reqPaths.every((p) => approvedSet.has(p)) ? "tool_family" : false;
      }
      return storedCanonical === candidate ? "tool_family" : false;
    }

    case "parent_class":
    case "exact":
    default:
      return storedCanonical === candidate ? storedStrategy : false;
  }
}

const planAuthorizes = (plan: ApprovedPlan | undefined, toolName: string, scope: string) =>
  findMatchingPlanStep(plan, toolName, scope);

const matchReasonLabel: Record<ScopeMatchStrategy, PolicyMatchReason> = {
  exact: "exact_scope",
  path_prefix: "path_prefix",
  parent_class: "parent_class",
  tool_family: "tool_family",
};

const matchAllowReason: Record<ScopeMatchStrategy, string> = {
  exact: "Covered by an approved execution scope.",
  path_prefix: "Covered by approved scope for this instance (any property).",
  parent_class: "Covered by approved class pattern for this parent.",
  tool_family: "Covered by approved bulk operation pattern.",
};

export class PermissionPolicy {
  assess(tool: AgentTool, input: Record<string, unknown>, conversation: Conversation, run: AgentRun): PolicyResult {
    const scope = tool.scope(input);
    const summary = `${label(tool)} (${scope})`;
    const scopeDescription = scopeApprovalDescription(tool.name, scope);

    if (tool.risk === "read") {
      return { decision: "allow", scope, summary, reason: "Read-only operations are allowed." };
    }

    if (run.mode === "plan") {
      return {
        decision: "deny",
        scope,
        summary,
        reason: "Plan mode is read-only. Start an execution run after the plan is approved.",
      };
    }

    // Full access mode: allow low_mutation and destructive without prompting.
    // runtime_code, external_asset, secret, and elevated still require explicit approval.
    if (run.fullAccess && (tool.risk === "low_mutation" || tool.risk === "destructive")) {
      return {
        decision: "allow",
        scope,
        summary,
        scopeDescription,
        reason: "Full access mode — mutations auto-approved.",
        matchReason: "full_access",
      };
    }

    const planStepIndex = planAuthorizes(conversation.approvedPlan, tool.name, scope);
    if (planStepIndex !== undefined) {
      return {
        decision: "allow",
        scope,
        summary,
        scopeDescription,
        reason: "Authorized by the user-approved plan.",
        matchReason: "plan",
        planStepIndex,
      };
    }

    for (const approved of conversation.approvedScopes) {
      const matched = scopeCoversRequest(approved, tool.name, scope);
      if (matched) {
        return {
          decision: "allow",
          scope,
          summary,
          scopeDescription,
          reason: matchAllowReason[matched],
          matchReason: matchReasonLabel[matched],
        };
      }
    }

    return {
      decision: "ask",
      scope,
      summary,
      scopeDescription,
      reason: tool.risk === "low_mutation"
        ? "This action changes the connected place."
        : "This is a high-risk change and requires explicit approval.",
    };
  }
}
