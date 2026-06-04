import { aiConfig, type ProfileId } from "./ai-config.ts";
import type { AgentMessage } from "./types.ts";

const OPENROUTER_DIRECT = "https://openrouter.ai/api/v1/chat/completions";

function resolveUrlAndHeaders(): { url: string; headers: Record<string, string> } {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error("Stud model access is unavailable on this server");

  const gatewayBase = (process.env.AI_GATEWAY_URL ?? "").replace(/\/$/, "");
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${orKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://stud.dev",
    "X-OpenRouter-Title": "Stud",
  };

  if (gatewayBase) {
    if (cfToken) headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
    return { url: `${gatewayBase}/openrouter/chat/completions`, headers };
  }

  return { url: OPENROUTER_DIRECT, headers };
}

function agentMessageText(message: AgentMessage): string {
  if (message.role === "user") return `User: ${message.content}`;
  if (message.role === "assistant") return `Assistant: ${message.content}`;
  return `Tool ${message.toolName}: ${JSON.stringify(message.output)}`;
}

export function serializeAgentMessages(messages: AgentMessage[], limit = 20_000): string {
  const text = messages.map(agentMessageText).join("\n\n");
  return text.length > limit ? text.slice(text.length - limit) : text;
}

export async function generateUtilityText({
  profileId = "summarizer",
  system,
  user,
  signal,
  temperature = 0.2,
}: {
  profileId?: ProfileId;
  system: string;
  user: string;
  signal: AbortSignal;
  temperature?: number;
}): Promise<string> {
  const { url, headers } = resolveUrlAndHeaders();
  const model = aiConfig.profiles[profileId].primary.model;
  const response = await fetch(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Utility LLM error ${response.status}: ${body}`);
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

export function parseJsonFromText<T>(text: string, fallback: T): T {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
    trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)?.[1],
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep looking
    }
  }
  return fallback;
}
