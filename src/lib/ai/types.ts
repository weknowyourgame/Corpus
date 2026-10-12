export type Tier = "free" | "pro" | "hyper" | "super";

export type ProfileId =
  | "planner-free"
  | "planner-pro"
  | "planner-hyper"
  | "planner-super"
  | "coder-free"
  | "coder-pro"
  | "coder-hyper"
  | "coder-super"
  | "classifier"
  | "summarizer"
  | "title-generator"
  | "embeddings";

export interface ModelSpec {
  /** OpenRouter model ID — provider/model-name */
  model: string;
}

export interface ProfileConfig {
  primary: ModelSpec;
  fallbacks?: string[];
}

export interface TierConfig {
  planner: ProfileId;
  coder: ProfileId;
}

export interface AiConfig {
  tiers: Record<Tier, TierConfig>;
  profiles: Record<ProfileId, ProfileConfig>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  profile: ProfileId;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  userId?: string;
  conversationId?: string;
  onTextDelta?: (text: string) => Promise<void> | void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurn {
  text: string;
  toolCalls: ToolCall[];
}

export interface EmbedOptions {
  texts: string[];
  userId?: string;
}

export interface ClassifyOptions {
  prompt: string;
  signal?: AbortSignal;
}

export interface SummarizeOptions {
  content: string;
  signal?: AbortSignal;
}

export interface TitleOptions {
  content: string;
  signal?: AbortSignal;
}
