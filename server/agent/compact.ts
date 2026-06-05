import { generateUtilityText, serializeAgentMessages } from "./utility-llm.ts";
import type { AgentMessage, AgentTier } from "./types.ts";

export const TIER_MAX_TOKENS: Record<AgentTier, number> = {
  free: 40_000,
  pro: 80_000,
  hyper: 150_000,
  super: 200_000,
};

export function estimateTokens(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function needsCompaction(messages: AgentMessage[], maxTokens: number): boolean {
  return estimateTokens(messages) > maxTokens * 0.75;
}

export async function compactMessages(messages: AgentMessage[], signal: AbortSignal): Promise<AgentMessage[]> {
  if (messages.length <= 12) return messages;
  const tail = messages.slice(-8);
  const old = messages.slice(0, -8);
  const summary = await generateUtilityText({
    profileId: "summarizer",
    signal,
    system: [
      "Compact an old Corpus agent conversation for a Roblox Studio project.",
      "Preserve user goals, decisions, created/edited script paths, approved scopes, important tool results, errors, and current plan state.",
      "Write concise plain text. Do not invent facts.",
    ].join("\n"),
    user: serializeAgentMessages(old, 48_000),
  });

  return [
    {
      role: "assistant",
      content: `<corpus_compacted_context>\n${summary || "Earlier conversation compacted."}\n</corpus_compacted_context>`,
      toolCalls: [],
    },
    ...tail,
  ];
}
