import { z } from "zod";
import { getPrismaClient } from "./prisma.ts";
import { generateUtilityText, parseJsonFromText, serializeAgentMessages } from "./utility-llm.ts";
import type { AgentMessage } from "./types.ts";

export type AgentMemory = {
  key: string;
  value: string;
  category: "project" | "preference" | "pattern";
};

const memorySchema = z.array(z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(600),
  category: z.enum(["project", "preference", "pattern"]),
})).max(8);

const fallbackMemories = new Map<string, AgentMemory[]>();

export async function extractMemories(
  messages: AgentMessage[],
  runText: string,
  signal: AbortSignal,
): Promise<AgentMemory[]> {
  const text = await generateUtilityText({
    profileId: "summarizer",
    signal,
    system: [
      "Extract durable facts for Corpus, a Roblox Studio AI agent.",
      "Return only JSON: [{\"key\":\"...\",\"value\":\"...\",\"category\":\"project|preference|pattern\"}].",
      "Keep facts that will help future runs: project architecture, user preferences, reusable implementation patterns.",
      "Ignore transient chatter, tool progress, and facts already too vague to act on.",
    ].join("\n"),
    user: [
      "<conversation>",
      serializeAgentMessages(messages, 16_000),
      "</conversation>",
      "<final_response>",
      runText.slice(-4_000),
      "</final_response>",
    ].join("\n"),
  });
  const parsed = parseJsonFromText<unknown>(text, []);
  const result = memorySchema.safeParse(parsed);
  return result.success ? result.data : [];
}

export async function storeMemories(conversationId: string, facts: AgentMemory[]): Promise<void> {
  if (!facts.length) return;
  if (!process.env.DATABASE_URL) {
    const existing = fallbackMemories.get(conversationId) ?? [];
    const byKey = new Map(existing.map((item) => [item.key, item]));
    for (const fact of facts) byKey.set(fact.key, fact);
    fallbackMemories.set(conversationId, [...byKey.values()].slice(-50));
    return;
  }

  const prisma = getPrismaClient() as unknown as {
    agentMemory: {
      upsert: (args: unknown) => Promise<unknown>;
      findMany: (args: unknown) => Promise<Array<{ key: string; value: string; category: string }>>;
    };
  };
  for (const fact of facts) {
    await prisma.agentMemory.upsert({
      where: { conversationId_key: { conversationId, key: fact.key } },
      update: {
        value: fact.value,
        category: fact.category,
      },
      create: {
        conversationId,
        key: fact.key,
        value: fact.value,
        category: fact.category,
      },
    });
  }
}

export async function loadMemories(conversationId: string): Promise<AgentMemory[]> {
  if (!process.env.DATABASE_URL) {
    return (fallbackMemories.get(conversationId) ?? []).slice(-10).reverse();
  }

  const prisma = getPrismaClient() as unknown as {
    agentMemory: {
      findMany: (args: unknown) => Promise<Array<{ key: string; value: string; category: string }>>;
    };
  };
  const rows = await prisma.agentMemory.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map((row: { key: string; value: string; category: string }) => ({
    key: row.key,
    value: row.value,
    category: row.category as AgentMemory["category"],
  }));
}

export function formatMemories(memories: AgentMemory[]): string | undefined {
  if (!memories.length) return undefined;
  return [
    "<corpus_memory>",
    ...memories.map((memory) => `[${memory.category}] ${memory.value}`),
    "</corpus_memory>",
  ].join("\n");
}
