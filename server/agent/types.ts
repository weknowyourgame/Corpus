export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AgentProvider = "anthropic" | "openrouter" | "codex";
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
  provider: AgentProvider;
  model: string;
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

export type DataStoreApprovalRequest = {
  approvalId: string;
  operation: "write" | "delete" | "increment";
  universe: string;
  store: string;
  scope: string;
  key: string;
  oldValue: string | null;
  newValue: string | null;
  risk: "destructive";
};

export type AgentEventData =
  | { type: "run_started"; provider: AgentProvider; model: string; mode: RunMode }
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
    }
  | { type: "approval_resolved"; approvalId: string; decision: ApprovalDecision }
  | { type: "plan_proposed"; text: string }
  | { type: "run_completed"; text: string; iterations: number }
  | { type: "run_cancelled"; reason: string }
  | { type: "run_error"; error: string }
  | { type: "context_snapshot"; studioConnected: boolean; selectedPaths: string[]; atMentions: Array<{ path: string; summary: string }> }
  | { type: "mutation_result"; transactionId: string; toolName: string; path: string; before?: string; after?: string; undoWaypoint?: string }
  | { type: "datastore_approval_pending"; approvalId: string; operation: DataStoreApprovalRequest["operation"]; store: string; key: string; oldValue: string | null; newValue: string | null }
  | { type: "datastore_approval_resolved"; approvalId: string; decision: ApprovalDecision };

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
  type: "prompt" | "tool_requested" | "policy_decision" | "approval_decision" | "tool_outcome" | "plan_proposed";
  actor: "user" | "model" | "policy" | "tool";
  toolCallId?: string;
  toolName?: string;
  risk?: ToolRisk;
  decision?: PolicyDecision | ApprovalDecision;
  summary: string;
  details?: JsonValue;
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
};

export type StartRunInput = {
  message: string;
  provider: AgentProvider;
  model: string;
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
  provider: AgentProvider;
  model: string;
}) => ModelDriver;

export type ToolExecutionContext = {
  conversationId: string;
  runId: string;
  operationId: string;
  studioSessionId: string;
  signal: AbortSignal;
  requestInteraction: (questions: AgentQuestion[]) => Promise<AgentAnswer[]>;
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
};

export interface AgentToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
}

export interface ConversationStore {
  create(studioSessionId: string, accessTokenHash?: string): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  save(conversation: Conversation): Promise<void>;
}
