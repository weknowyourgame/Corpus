import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { z } from "zod";
import { ROBLOX_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { AgentMessage, AgentToolRegistry, ModelDriver, ModelDriverFactory, ModelTurn } from "./types.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";

const schema = (input: unknown) => input as z.ZodType<Record<string, unknown>>;

function aiMessages(messages: AgentMessage[]) {
  // Collect every tool call ID that has a result so we can detect orphans
  // left behind when a previous run was interrupted before results were saved.
  const resolved = new Set(
    messages
      .filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => m.toolCallId),
  );

  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "tool") {
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          output: { type: "json", value: message.output },
        }],
      });
    } else {
      // assistant
      if (!message.toolCalls.length) {
        out.push({ role: "assistant", content: message.content });
      } else {
        out.push({
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        });
        // Inject a stub result for any call that has no recorded result —
        // this happens when a previous run was killed between the assistant
        // turn and the tool execution. Without this the AI SDK throws
        // AI_MissingToolResultsError on the very next generate() call.
        for (const call of message.toolCalls) {
          if (!resolved.has(call.id)) {
            out.push({
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "json", value: { interrupted: true, reason: "Run was cancelled before this tool completed." } },
              }],
            });
          }
        }
      }
    }
  }
  return out as never[];
}

class AiSdkDriver implements ModelDriver {
  constructor(
    private readonly provider: "anthropic" | "openrouter",
    private readonly model: string,
    private readonly tools: AgentToolRegistry,
  ) {}

  async generate(input: Parameters<ModelDriver["generate"]>[0]) {
    const key = this.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error(`Set ${this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"} on the bridge server`);
    const model = this.provider === "anthropic"
      ? createAnthropic({ apiKey: key })(this.model)
      : createOpenAI({
          apiKey: key,
          baseURL: OPENROUTER_BASE,
          headers: { "HTTP-Referer": "https://stud.dev", "X-OpenRouter-Title": "Stud" },
        }).chat(this.model);
    const tools = Object.fromEntries(this.tools.list().map((entry) => [
      entry.name,
      tool({ description: entry.description, inputSchema: schema(entry.inputSchema) }),
    ]));
    const systemPrompt = input.systemContext
      ? `${ROBLOX_AGENT_SYSTEM_PROMPT}\n\n${input.systemContext}`
      : ROBLOX_AGENT_SYSTEM_PROMPT;
    const result = streamText({
      model,
      system: systemPrompt,
      tools,
      messages: aiMessages(input.messages) as never,
      abortSignal: input.signal,
    });
    let text = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const calls: ModelTurn["toolCalls"] = [];
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") {
        text += event.text;
        await input.onTextDelta(event.text);
      } else if (event.type === "reasoning-delta") {
        reasoning += event.text ?? "";
      } else if (event.type === "tool-call") {
        calls.push({
          id: event.toolCallId,
          name: event.toolName,
          input: event.input as Record<string, unknown>,
        });
      } else if (event.type === "finish-step" || event.type === "finish") {
        finishReason = event.finishReason;
      } else if (event.type === "error") {
        const err = event.error instanceof Error
          ? event.error
          : new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
        console.error(`[driver] stream error from ${this.provider}/${this.model}:`, err.message);
        throw err;
      } else if (event.type === "abort") {
        throw new Error(`Model stream aborted: ${event.reason ?? "unknown"}`);
      }
    }
    if (!text && !calls.length) {
      const detail = reasoning
        ? `Model returned reasoning only (no visible output or tool calls). finishReason=${finishReason ?? "unknown"}. This usually means the model is a pure thinking variant or the response was cut off by the provider.`
        : `Model returned no output and no tool calls. finishReason=${finishReason ?? "unknown"}. The upstream connection likely terminated early.`;
      throw new Error(detail);
    }
    return { text: text || reasoning, toolCalls: calls };
  }
}

type CodexInput =
  | { role: "user"; content: Array<{ type: "input_text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function codexMessages(messages: AgentMessage[]): CodexInput[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      return [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
    }
    if (message.role === "tool") {
      return [{ type: "function_call_output", call_id: message.toolCallId, output: JSON.stringify(message.output) }];
    }
    return [
      ...(message.content ? [{ role: "assistant", content: [{ type: "output_text", text: message.content }] }] : []),
      ...message.toolCalls.map((call) => ({
        type: "function_call" as const,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input),
      })),
    ] as CodexInput[];
  });
}

class CodexDriver implements ModelDriver {
  constructor(private readonly model: string, private readonly tools: AgentToolRegistry) {}

  async generate(input: Parameters<ModelDriver["generate"]>[0]) {
    const accessToken = process.env.STUD_CODEX_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Set STUD_CODEX_ACCESS_TOKEN on the bridge server");
    const instructions = input.systemContext
      ? `${ROBLOX_AGENT_SYSTEM_PROMPT}\n\n${input.systemContext}`
      : ROBLOX_AGENT_SYSTEM_PROMPT;
    const body = {
      model: this.model,
      instructions,
      input: codexMessages(input.messages),
      tools: this.tools.list().map((entry) => ({
        type: "function",
        name: entry.name,
        description: entry.description,
        parameters: z.toJSONSchema(schema(entry.inputSchema), { unrepresentable: "any" }),
      })),
      stream: true,
      store: false,
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (process.env.STUD_CODEX_ACCOUNT_ID) headers["ChatGPT-Account-Id"] = process.env.STUD_CODEX_ACCOUNT_ID;
    const response = await fetch(CODEX_API, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Codex API error: ${response.status} - ${await response.text()}`);
    if (!response.body) throw new Error("Codex API returned no stream body");

    let text = "";
    let buffer = "";
    const calls: ModelTurn["toolCalls"] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const event = JSON.parse(line.slice(6)) as {
          type: string;
          delta?: string;
          item?: { type?: string; call_id?: string; id?: string; name?: string; arguments?: string };
        };
        if (event.type === "response.output_text.delta") {
          const delta = event.delta ?? "";
          text += delta;
          await input.onTextDelta(delta);
        }
        if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
          calls.push({
            id: event.item.call_id ?? event.item.id ?? crypto.randomUUID(),
            name: event.item.name ?? "",
            input: JSON.parse(event.item.arguments ?? "{}") as Record<string, unknown>,
          });
        }
      }
    }
    return { text, toolCalls: calls };
  }
}

export function createModelDriverFactory(tools: AgentToolRegistry): ModelDriverFactory {
  return ({ provider, model }) => provider === "codex"
    ? new CodexDriver(model, tools)
    : new AiSdkDriver(provider, model, tools);
}
