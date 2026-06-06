import type { ApprovalDecision, AgentQuestion, AgentTier, RunMode } from "../agent/types.ts";
import type { AgentRuntime } from "../agent/runtime.ts";

export type DiscordConfig = {
  enabled: boolean;
  token: string;
  clientId: string;
  guildIds: string[];
  allowedRoleIds: string[];
  adminRoleIds: string[];
  commandName: string;
  registerCommands: boolean;
  requireMention: boolean;
  defaultTier: AgentTier;
  fullAccess: boolean;
  maxPromptLength: number;
};

export type DiscordProject = {
  id: string;
  guildId: string;
  channelId: string;
  ownerDiscordId: string;
  conversationId: string;
  studioSessionId: string;
  lastRunId?: string | null;
  disconnectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DiscordProjectInput = {
  guildId: string;
  channelId: string;
  ownerDiscordId: string;
  conversationId: string;
  studioSessionId: string;
};

export type DiscordApprovalAction = {
  type: "approval";
  conversationId: string;
  runId: string;
  approvalId: string;
  decision: ApprovalDecision;
};

export type DiscordPlanAction = {
  type: "plan";
  conversationId: string;
  planId: string;
  decision: "approve" | "reject";
};

export type DiscordAction = DiscordApprovalAction | DiscordPlanAction;

export type DiscordPendingInteraction = {
  conversationId: string;
  runId: string;
  interactionId: string;
  questions: AgentQuestion[];
};

export type DiscordStudioStatus = {
  connected: boolean;
  pluginConnected: boolean;
  pending_requests: number;
  last_poll_time: number | null;
  pluginVersion?: string | null;
  capabilities?: string[];
};

export type DiscordBotDeps = {
  runtime: AgentRuntime;
  studioStatus: (studioSessionId: string) => DiscordStudioStatus;
  resolveStudioSession: (tokenOrSessionId: string) => { sessionId: string; studioConnected: boolean } | null;
};

export type DiscordRunRequest = {
  prompt: string;
  mode: RunMode;
};
