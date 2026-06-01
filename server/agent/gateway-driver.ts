/**
 * GatewayDriver — server-side ModelDriver.
 *
 * Two modes:
 *
 * A) CF AI Gateway  (AI_GATEWAY_URL set)
 *    URL:  {AI_GATEWAY_URL}/openrouter/v1/chat/completions
 *    Auth: Authorization: Bearer {OPENROUTER_API_KEY}  ← forwarded to OpenRouter
 *          cf-aig-authorization: Bearer {CLOUDFLARE_API_TOKEN}  ← only if gateway has auth enabled
 *    All OpenRouter models work (nvidia/, meta/, deepseek/, etc.)
 *
 * B) OpenRouter direct  (no AI_GATEWAY_URL)
 *    URL:  https://openrouter.ai/api/v1/chat/completions
 *    Auth: Authorization: Bearer {OPENROUTER_API_KEY}
 *
 * Required: OPENROUTER_API_KEY always.
 * Optional: AI_GATEWAY_URL + CLOUDFLARE_API_TOKEN for CF gateway.
 */

import { z } from "zod";
import { ROBLOX_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { aiConfig } from "./ai-config.ts";
import type { ProfileId, Tier } from "./ai-config.ts";
import type { AgentMessage, AgentToolRegistry, ModelDriver, ModelTurn } from "./types.ts";

const OPENROUTER_DIRECT = "https://openrouter.ai/api/v1/chat/completions";

function resolveUrlAndHeaders(): { url: string; headers: Record<string, string> } {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    throw new Error("Stud model access is unavailable on this server");
  }

  const gatewayBase = (process.env.AI_GATEWAY_URL ?? "").replace(/\/$/, "");
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;

  const headers: Record<string, string> = {
    // OpenRouter key always goes here — CF gateway forwards it to OpenRouter
    Authorization: `Bearer ${orKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://stud.dev",
    "X-OpenRouter-Title": "Stud",
  };

  if (gatewayBase) {
    // cf-aig-authorization authenticates YOU to the CF gateway itself
    // Only needed if your gateway has "Require authentication" turned on in CF dashboard
    if (cfToken) headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
    return {
      url: `${gatewayBase}/openrouter/chat/completions`,
      headers,
    };
  }

  return { url: OPENROUTER_DIRECT, headers };
}

const schema = (input: unknown) => input as z.ZodType<Record<string, unknown>>;

function agentMessagesToOpenRouter(messages: AgentMessage[]) {
  const resolved = new Set(
    messages
      .filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => m.toolCallId),
  );

  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: JSON.stringify(msg.output),
      });
    } else {
      if (!msg.toolCalls.length) {
        out.push({ role: "assistant", content: msg.content });
      } else {
        out.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        });
        for (const call of msg.toolCalls) {
          if (!resolved.has(call.id)) {
            out.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ interrupted: true, reason: "Run was cancelled before this tool completed." }),
            });
          }
        }
      }
    }
  }
  return out;
}

function buildRequestBody(
  primaryModel: string,
  fallbacks: string[],
  messages: AgentMessage[],
  tools: AgentToolRegistry,
  systemContext?: string,
) {
  const systemText = systemContext ? `${ROBLOX_AGENT_SYSTEM_PROMPT}\n\n${systemContext}` : ROBLOX_AGENT_SYSTEM_PROMPT;
  const toolDefs = tools.list().map((entry) => ({
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
      parameters: z.toJSONSchema(schema(entry.inputSchema), { unrepresentable: "any" }),
    },
  }));

  const body: Record<string, unknown> = {
    model: primaryModel,
    messages: [{ role: "system", content: systemText }, ...agentMessagesToOpenRouter(messages)],
    stream: true,
    tools: toolDefs,
  };

  if (fallbacks.length > 0) {
    body.models = [primaryModel, ...fallbacks];
  }

  return body;
}

class GatewayDriver implements ModelDriver {
  constructor(
    private readonly profileId: ProfileId,
    private readonly tools: AgentToolRegistry,
    private readonly devModel?: string,
  ) {}

  async generate(input: Parameters<ModelDriver["generate"]>[0]): Promise<ModelTurn> {
    return this.generateWithRetry(input, 2);
  }

  private async generateWithRetry(
    input: Parameters<ModelDriver["generate"]>[0],
    attemptsLeft: number,
  ): Promise<ModelTurn> {
    const primaryModel = this.devModel ?? aiConfig.profiles[this.profileId].primary.model;
    const fallbacks = this.devModel ? [] : (aiConfig.profiles[this.profileId].fallbacks ?? []);

    const { url, headers } = resolveUrlAndHeaders();
    const body = buildRequestBody(primaryModel, fallbacks, input.messages, this.tools, input.systemContext);

    const usingGateway = Boolean(process.env.AI_GATEWAY_URL);
    console.log(`[gateway-driver] ${usingGateway ? "CF Gateway /openrouter" : "OpenRouter direct"} → ${primaryModel}`);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gateway error ${response.status} for profile ${this.profileId}: ${text}`);
    }
    if (!response.body) throw new Error("No stream body from gateway");

    let text = "";
    let finishReason: string | undefined;
    const calls: ModelTurn["toolCalls"] = [];
    const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const event = JSON.parse(line.slice(6)) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
          };
          const choice = event.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          if (delta.content) {
            text += delta.content;
            await input.onTextDelta(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!pendingCalls.has(tc.index)) {
                pendingCalls.set(tc.index, { id: tc.id ?? crypto.randomUUID(), name: tc.function?.name ?? "", args: "" });
              }
              const call = pendingCalls.get(tc.index)!;
              if (tc.id && !call.id) call.id = tc.id;
              if (tc.function?.name && !call.name) call.name = tc.function.name;
              if (tc.function?.arguments) call.args += tc.function.arguments;
            }
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    for (const call of pendingCalls.values()) {
      calls.push({
        id: call.id,
        name: call.name,
        input: JSON.parse(call.args || "{}") as Record<string, unknown>,
      });
    }

    if (!text && !calls.length) {
      if (attemptsLeft > 1) {
        console.warn(`[gateway-driver] empty response for ${this.profileId} (finishReason=${finishReason ?? "unknown"}), retrying (${attemptsLeft - 1} left)`);
        return this.generateWithRetry(input, attemptsLeft - 1);
      }
      throw new Error(`Model returned no output and no tool calls. finishReason=${finishReason ?? "unknown"}.`);
    }

    return { text, toolCalls: calls };
  }
}

export function createGatewayDriverFactory(tools: AgentToolRegistry) {
  return ({ tier, devModel }: { tier: Tier; devModel?: string }): ModelDriver => {
    const profileId = aiConfig.tiers[tier].coder;
    return new GatewayDriver(profileId, tools, devModel);
  };
}

export function createPlannerDriverFactory(tools: AgentToolRegistry) {
  return ({ tier, devModel }: { tier: Tier; devModel?: string }): ModelDriver => {
    const profileId = aiConfig.tiers[tier].planner;
    return new GatewayDriver(profileId, tools, devModel);
  };
}
