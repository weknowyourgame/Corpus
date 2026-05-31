// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import type { AgentTool, AgentToolRegistry, ModelDriver, ModelDriverFactory } from "./types.ts";

const waitFor = async (test: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for runtime state");
};

const read: AgentTool = {
  name: "read",
  description: "read",
  transport: "studio_mcp",
  risk: "read",
  concurrency: "parallel_read",
  inputSchema: {},
  scope: (input) => String(input.path ?? "game"),
  execute: async (input) => ({ executed: "read", input: JSON.stringify(input) }),
};
const tools: AgentToolRegistry = {
  list: () => [read],
  get: (name) => name === read.name ? read : undefined,
};

describe("AgentRuntime", () => {
  it("continues a model turn with a structured tool result", async () => {
    let call = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async (input) => {
        call += 1;
        if (call === 1) {
          await input.onTextDelta("Inspecting. ");
          return { text: "Inspecting. ", toolCalls: [{ id: "tool-1", name: "read", input: { path: "game.Workspace" } }] };
        }
        expect(input.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "tool-1" });
        await input.onTextDelta("Done.");
        return { text: "Done.", toolCalls: [] };
      },
    });
    const store = new MemoryConversationStore();
    const runtime = new AgentRuntime(store, factory, tools, 3);
    const conversation = await runtime.createConversation("ABCDEF12");

    const run = await runtime.startRun(conversation.id, { message: "Look", tier: "pro" });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");

    const saved = await runtime.getConversation(conversation.id);
    expect(saved?.runs[0]).toMatchObject({ id: run.id, status: "completed", iterations: 2 });
    expect(saved?.events.map((event) => event.type)).toEqual([
      "run_started",
      "text_delta",
      "tool_call",
      "tool_result",
      "text_delta",
      "run_completed",
    ]);
  });

  it("replays persisted events after the requested sequence cursor", async () => {
    const driver: ModelDriver = {
      generate: async (input) => {
        await input.onTextDelta("Hello");
        return { text: "Hello", toolCalls: [] };
      },
    };
    const runtime = new AgentRuntime(new MemoryConversationStore(), () => driver, tools);
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Hi", tier: "pro" });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");
    const replayed: string[] = [];

    const unsubscribe = await runtime.subscribe(conversation.id, 1, (event) => replayed.push(event.type));
    unsubscribe();

    expect(replayed).toEqual(["text_delta", "run_completed"]);
  });

  it("cancels an in-flight model generation and records cancellation", async () => {
    const driver: ModelDriver = {
      generate: (input) => new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    };
    const runtime = new AgentRuntime(new MemoryConversationStore(), () => driver, tools);
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "Wait", tier: "pro" });

    expect(await runtime.cancelRun(conversation.id, run.id)).toBe(true);
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "cancelled");

    const saved = await runtime.getConversation(conversation.id);
    expect(saved?.events.at(-1)?.type).toBe("run_cancelled");
  });
});
