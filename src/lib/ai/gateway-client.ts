/**
 * GatewayClient — single AI client for all AI calls.
 *
 * Routes through Cloudflare AI Gateway → OpenRouter (primary) with
 * Anthropic/Gemini fallbacks. Callers use profile IDs, never model names.
 *
 * Environment (server-side):
 *   AI_GATEWAY_URL       — Cloudflare AI Gateway base URL (required)
 *   OPENROUTER_API_KEY   — OpenRouter key (required)
 *   CLOUDFLARE_API_TOKEN — Cloudflare token (required)
 *   ANTHROPIC_API_KEY    — optional fallback
 *   GEMINI_API_KEY       — optional fallback
 *
 * Browser callers never receive keys; this module runs server-side.
 */

import { aiConfig } from "./config";
import type {
  ChatOptions,
  ChatTurn,
  EmbedOptions,
  ClassifyOptions,
  SummarizeOptions,
  TitleOptions,
  ToolDefinition,
} from "./types";

const CF_OPENROUTER_PROVIDER = "openrouter";
const CF_ANTHROPIC_PROVIDER = "anthropic";
const CF_WORKERS_AI_PROVIDER = "workers-ai";

function env(key: string) {
  if (typeof process !== "undefined") return process.env[key];
  return undefined;
}

function requiredEnv(key: string) {
  const v = env(key);
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function buildGatewayUrl(provider: string, path: string) {
  const base = requiredEnv("AI_GATEWAY_URL").replace(/\/$/, "");
  return `${base}/${provider}${path}`;
}

function metadataHeaders(userId?: string, conversationId?: string): Record<string, string> {
  const meta: Record<string, string> = {};
  if (userId || conversationId) {
    meta["cf-aig-metadata"] = JSON.stringify({
      ...(userId && { user_id: userId }),
      ...(conversationId && { conversation_id: conversationId }),
    });
  }
  if (userId) meta["cf-aig-custom-cache-key"] = userId;
  return meta;
}

function openRouterHeaders(userId?: string, conversationId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${requiredEnv("OPENROUTER_API_KEY")}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://stud.dev",
    "X-OpenRouter-Title": "Stud",
    ...metadataHeaders(userId, conversationId),
  };
}


function buildUniversalBody(
  primaryModel: string,
  fallbacks: string[],
  messages: ChatOptions["messages"],
  system?: string,
  tools?: ToolDefinition[],
  stream = true,
) {
  const providerOrder = [
    { order: [CF_OPENROUTER_PROVIDER, CF_ANTHROPIC_PROVIDER], allow_fallbacks: true },
  ];

  const body: Record<string, unknown> = {
    model: primaryModel,
    messages: system
      ? [{ role: "system", content: system }, ...messages]
      : messages,
    stream,
    provider: providerOrder,
  };

  if (fallbacks.length > 0) body.models = [primaryModel, ...fallbacks];
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // Apply Anthropic prompt cache markers to system + first large user message
  if (system) {
    body.messages = [
      {
        role: "system",
        content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      },
      ...messages,
    ];
  }

  return body;
}

async function streamOpenRouter(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  onTextDelta?: (text: string) => Promise<void> | void,
): Promise<ChatTurn> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway error ${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body from gateway");

  let text = "";
  let buffer = "";
  const toolCalls: ChatTurn["toolCalls"] = [];
  const pendingCalls = new Map<string, { name: string; args: string }>();
  const decoder = new TextDecoder();

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
        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          await onTextDelta?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key = String(tc.index);
            if (!pendingCalls.has(key)) {
              pendingCalls.set(key, { name: tc.function?.name ?? "", args: "" });
            }
            const call = pendingCalls.get(key)!;
            if (tc.function?.name && !call.name) call.name = tc.function.name;
            if (tc.function?.arguments) call.args += tc.function.arguments;
            if (tc.id) (call as Record<string, unknown>)["id"] = tc.id;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  for (const [, call] of pendingCalls) {
    toolCalls.push({
      id: (call as Record<string, unknown>)["id"] as string ?? crypto.randomUUID(),
      name: call.name,
      input: JSON.parse(call.args || "{}") as Record<string, unknown>,
    });
  }

  return { text, toolCalls };
}

export class GatewayClient {
  async chat(options: ChatOptions): Promise<ChatTurn> {
    const profile = aiConfig.profiles[options.profile];
    if (!profile) throw new Error(`Unknown profile: ${options.profile}`);

    const primaryModel = profile.primary.model;
    const fallbacks = profile.fallbacks ?? [];
    const url = buildGatewayUrl(CF_OPENROUTER_PROVIDER, "/chat/completions");
    const headers = openRouterHeaders(options.userId, options.conversationId);
    const body = buildUniversalBody(primaryModel, fallbacks, options.messages, options.system, options.tools);

    return streamOpenRouter(url, body, headers, options.signal, options.onTextDelta);
  }

  async embed(options: EmbedOptions): Promise<number[][]> {
    const url = buildGatewayUrl(CF_WORKERS_AI_PROVIDER, "/@cf/baai/bge-large-en-v1.5");
    const token = requiredEnv("CLOUDFLARE_API_TOKEN");

    const results: number[][] = [];
    const batchSize = 100;

    for (let i = 0; i < options.texts.length; i += batchSize) {
      const batch = options.texts.slice(i, i + batchSize);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...metadataHeaders(options.userId),
        },
        body: JSON.stringify({ text: batch }),
      });
      if (!response.ok) throw new Error(`Workers AI embed error: ${response.status}`);
      const json = (await response.json()) as { result: { data: number[][] } };
      results.push(...json.result.data);
    }

    return results;
  }

  async classify(options: ClassifyOptions): Promise<string> {
    const profile = aiConfig.profiles["classifier"];
    const url = buildGatewayUrl(CF_WORKERS_AI_PROVIDER, "/@cf/meta/llama-3.3-70b-instruct");
    const token = requiredEnv("CLOUDFLARE_API_TOKEN");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: options.prompt }],
        model: profile.primary.model,
      }),
      signal: options.signal,
    });

    if (!response.ok) throw new Error(`Classify error: ${response.status}`);
    const json = (await response.json()) as { result: { response: string } };
    return json.result.response;
  }

  async summarize(options: SummarizeOptions): Promise<string> {
    const profile = aiConfig.profiles["summarizer"];
    const url = buildGatewayUrl(CF_OPENROUTER_PROVIDER, "/chat/completions");
    const headers = openRouterHeaders();
    const body = {
      model: profile.primary.model,
      messages: [{ role: "user", content: `Summarize concisely:\n\n${options.content}` }],
      stream: false,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Summarize error: ${response.status}`);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content ?? "";
  }

  async generateTitle(options: TitleOptions): Promise<string> {
    const profile = aiConfig.profiles["title-generator"];
    const url = buildGatewayUrl(CF_OPENROUTER_PROVIDER, "/chat/completions");
    const headers = openRouterHeaders();
    const body = {
      model: profile.primary.model,
      messages: [
        {
          role: "user",
          content: `Generate a short, descriptive title (5 words max) for this content. Return ONLY the title, no quotes:\n\n${options.content}`,
        },
      ],
      stream: false,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Title generation error: ${response.status}`);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content?.trim() ?? "";
  }
}

export const gatewayClient = new GatewayClient();
