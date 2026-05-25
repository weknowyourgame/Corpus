export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AgentProvider = "anthropic" | "openrouter" | "codex";

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

export type AgentEventData =
  | { type: "run_started"; provider: AgentProvider; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: JsonValue }
  | {
      type: "interaction_requested";
      interactionId: string;
      questions: AgentQuestion[];
    }
  | { type: "run_completed"; text: string; iterations: number }
  | { type: "run_cancelled"; reason: string }
  | { type: "run_error"; error: string };

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

export type Conversation = {
  id: string;
  studioSessionId: string;
  createdAt: string;
  updatedAt: string;
  nextSequence: number;
  messages: AgentMessage[];
  runs: AgentRun[];
  events: AgentEvent[];
};

export type RunCredentials = {
  apiKey?: string;
  accessToken?: string;
  accountId?: string;
};

export type StartRunInput = {
  message: string;
  provider: AgentProvider;
  model: string;
  credentials?: RunCredentials;
};

export type ModelTurn = {
  text: string;
  toolCalls: AgentToolCall[];
};

export type GenerateTurnInput = {
  messages: AgentMessage[];
  signal: AbortSignal;
  onTextDelta: (text: string) => Promise<void>;
};

export interface ModelDriver {
  generate(input: GenerateTurnInput): Promise<ModelTurn>;
}

export type ModelDriverFactory = (input: {
  provider: AgentProvider;
  model: string;
  credentials?: RunCredentials;
}) => ModelDriver;

export interface ConversationStore {
  create(studioSessionId: string): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  save(conversation: Conversation): Promise<void>;
}

