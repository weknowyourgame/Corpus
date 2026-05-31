export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AgentTier = "free" | "pro" | "hyper" | "super";
export type RunMode = "execute" | "plan";
export type ToolRisk = "read" | "low_mutation" | "destructive" | "runtime_code" | "external_asset" | "secret";
export type PolicyDecision = "allow" | "ask" | "deny";
export type ApprovalDecision = "allow_once" | "allow_scope" | "insert_without_scripts" | "deny";

export type AgentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; output: JsonValue };

export type RunStatus = "running" | "completed" | "cancelled" | "error";

export type AgentRun = {
  id: string;
  status: RunStatus;
  mode: RunMode;
  tier: AgentTier;
  startedAt: string;
  completedAt?: string;
  error?: string;
  iterations: number;
};

export type AgentEventBase = {
  sequence: number;
  conversationId: string;
  runId: string;
  timestamp: string;
};

export type PlanStep = {
  toolName: string;
  scope: string;
  summary: string;
};

export type ProposedPlan = {
  planId: string;
  steps: PlanStep[];
  summary: string;
  submittedAt: string;
};

export type ApprovedPlan = {
  planId: string;
  steps: PlanStep[];
  summary: string;
  approvedAt: string;
  // Steps consumed (matched against tool calls) so we don't reuse a step
  // indefinitely. A consumed step does not authorise repeat execution.
  consumedStepIndices: number[];
};

export type SubagentProgressKind = "started" | "iteration" | "finding" | "completed" | "cancelled";

export type AgentEventData =
  | { type: "run_started"; tier: AgentTier; mode: RunMode }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: JsonValue }
  | {
      type: "interaction_requested";
      interactionId: string;
      questions: AgentQuestion[];
    }
  | { type: "interaction_resolved"; interactionId: string }
  | {
      type: "approval_pending";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
      scope: string;
      risk: Exclude<ToolRisk, "read">;
      preview?: JsonValue;
      allowStripScripts?: boolean;
      elevated?: boolean;
    }
  | { type: "approval_resolved"; approvalId: string; decision: ApprovalDecision }
  | { type: "plan_proposed"; text: string }
  | { type: "plan_steps_proposed"; planId: string; steps: PlanStep[]; summary: string }
  | { type: "plan_approved"; planId: string; steps: PlanStep[] }
  | { type: "plan_rejected"; planId: string }
  | { type: "subagent_progress"; subagentId: string; subagentType: string; kind: SubagentProgressKind; message: string; iteration?: number }
  | { type: "run_completed"; text: string; iterations: number }
  | { type: "run_cancelled"; reason: string }
  | { type: "run_error"; error: string }
  | { type: "context_snapshot"; studioConnected: boolean; selectedPaths: string[]; atMentions: Array<{ path: string; summary: string }> }
  | { type: "mutation_result"; transactionId: string; toolName: string; path: string; before?: string; after?: string; undoWaypoint?: string };

export type AgentEvent = AgentEventBase & AgentEventData;

export type AgentQuestionOption = {
  label: string;
  value?: string;
  imageUrl?: string;
  description?: string;
};

export type AgentQuestion = {
  question: string;
  options?: Array<string | AgentQuestionOption>;
  type: "single" | "multi" | "text";
};

export type AgentAnswer = string | string[];

export type ApprovedScope = {
  id: string;
  toolName: string;
  scope: string;
  approvedAt: string;
  approvalId: string;
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  runId: string;
  type: "prompt" | "tool_requested" | "policy_decision" | "approval_decision" | "tool_outcome" | "plan_proposed" | "plan_submitted" | "plan_decision" | "run_recovered";
  actor: "user" | "model" | "policy" | "tool" | "system";
  toolCallId?: string;
  toolName?: string;
  risk?: ToolRisk;
  decision?: PolicyDecision | ApprovalDecision;
  summary: string;
  details?: JsonValue;
};

export type PendingApprovalRecord = {
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  scope: string;
  risk: Exclude<ToolRisk, "read">;
  preview?: JsonValue;
  allowStripScripts?: boolean;
  elevated?: boolean;
  createdAt: string;
};

export type PendingInteractionRecord = {
  interactionId: string;
  runId: string;
  questions: AgentQuestion[];
  createdAt: string;
};

export type Conversation = {
  id: string;
  studioSessionId: string;
  accessTokenHash?: string;
  createdAt: string;
  updatedAt: string;
  nextSequence: number;
  messages: AgentMessage[];
  runs: AgentRun[];
  events: AgentEvent[];
  approvedScopes: ApprovedScope[];
  auditEvents: AuditEvent[];
  pendingApprovals?: PendingApprovalRecord[];
  pendingInteractions?: PendingInteractionRecord[];
  proposedPlan?: ProposedPlan;
  approvedPlan?: ApprovedPlan;
};

export type StartRunInput = {
  message: string;
  tier: AgentTier;
  devModel?: string;
  mode?: RunMode;
  rateLimiterRelease?: () => void;
};

export type ModelTurn = {
  text: string;
  toolCalls: AgentToolCall[];
};

export type GenerateTurnInput = {
  messages: AgentMessage[];
  signal: AbortSignal;
  onTextDelta: (text: string) => Promise<void>;
  systemContext?: string;
};

export interface ModelDriver {
  generate(input: GenerateTurnInput): Promise<ModelTurn>;
}

export type ModelDriverFactory = (input: {
  tier: AgentTier;
  devModel?: string;
}) => ModelDriver;

export type SubagentProgressEvent = {
  subagentId: string;
  subagentType: string;
  kind: SubagentProgressKind;
  message: string;
  iteration?: number;
};

export type ToolExecutionContext = {
  conversationId: string;
  runId: string;
  operationId: string;
  studioSessionId: string;
  signal: AbortSignal;
  requestInteraction: (questions: AgentQuestion[]) => Promise<AgentAnswer[]>;
  /**
   * Capture a structured plan produced by the model. Only meaningful in
   * plan mode; the runtime persists it on the conversation so the user
   * can approve or reject it from the UI before any execution.
   */
  setProposedPlan?: (plan: ProposedPlan) => Promise<void>;
  /**
   * Emit a subagent progress event on the parent run's event stream. The
   * runtime forwards these so the UI can render live status for long
   * subagent analyses.
   */
  emitSubagentProgress?: (event: SubagentProgressEvent) => Promise<void>;
};

export type AgentTool = {
  name: string;
  description: string;
  transport: "server" | "studio_mcp" | "open_cloud";
  risk: ToolRisk;
  concurrency: "parallel_read" | "exclusive_mutation";
  inputSchema: unknown;
  scope: (input: Record<string, unknown>) => string;
  preview?: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<JsonValue>;
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<JsonValue>;
  /**
   * Returns a safe representation of the tool input for events, audit logs, and
   * conversation snapshots. Use this when the raw input contains values that
   * must not be persisted in cleartext (e.g. DataStore writes). Defaults to the
   * raw input when not provided.
   */
  redactInput?: (input: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Returns whether this specific invocation should be flagged as elevated risk
   * in the approval UI. Used to highlight production-environment actions.
   */
  isElevated?: (input: Record<string, unknown>) => boolean;
};

export interface AgentToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
}

export interface ConversationStore {
  create(studioSessionId: string, accessTokenHash?: string): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  /**
   * Persist the conversation's snapshot fields (messages, runs, audit, pendings,
   * plans, approved scopes). Implementations MAY skip writing the events array
   * if `appendEvent` is the canonical persistence path for events.
   */
  save(conversation: Conversation): Promise<void>;
  /**
   * Append a single agent event durably. The runtime's hot path (text deltas)
   * calls this instead of `save` to avoid rewriting the full snapshot on every
   * token. Implementations MUST persist the event before resolving.
   */
  appendEvent?(conversationId: string, event: AgentEvent): Promise<void>;
  /**
   * Mark any runs left in `running` state as cancelled because the process is
   * starting fresh. Returns the conversation ids that needed cleanup. Called
   * once during server bootstrap. Implementations that are purely in-memory
   * may no-op.
   */
  recoverFromCrash?(): Promise<string[]>;
}

export type AuditEventType = AuditEvent["type"];
