// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import type { AgentEvent, AgentTool, AgentToolRegistry, ModelDriver } from "./types.ts";

const read: AgentTool = {
  name: "read",
  description: "read",
  transport: "studio_mcp",
  risk: "read",
  concurrency: "parallel_read",
  inputSchema: {},
  scope: () => "any",
  execute: async () => ({ ok: true }),
};
const tools: AgentToolRegistry = { list: () => [read], get: (name) => name === read.name ? read : undefined };

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out");
};

describe("event stream resume", () => {
  it("delivers only events strictly after the cursor when a client reconnects mid-stream", async () => {
    const stages: Array<() => void> = [];
    let gate: Promise<void> = Promise.resolve();
    const release: () => void = () => undefined;
    let nextRelease = release;

    const driver: ModelDriver = {
      generate: async (input) => {
        await input.onTextDelta("a");
        await input.onTextDelta("b");
        // Park here until the test releases the driver. This gives the
        // reconnecting subscriber a deterministic chance to see exactly
        // the first two text deltas before any more arrive.
        gate = new Promise((resolve) => { nextRelease = resolve; });
        stages.push(nextRelease);
        await gate;
        await input.onTextDelta("c");
        return { text: "abc", toolCalls: [] };
      },
    };

    const runtime = new AgentRuntime(new MemoryConversationStore(), () => driver, tools);
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "go", provider: "anthropic", model: "test" });

    // Wait for two text deltas to have landed before we subscribe.
    await waitFor(async () => {
      const conv = await runtime.getConversation(conversation.id);
      const deltas = conv?.events.filter((event) => event.type === "text_delta") ?? [];
      return deltas.length >= 2 ? true : undefined;
    });

    const conv = await runtime.getConversation(conversation.id);
    const cursor = conv!.events.find((event) => event.type === "text_delta")!.sequence; // first text_delta sequence
    const received: AgentEvent[] = [];
    const unsubscribe = await runtime.subscribe(conversation.id, cursor, (event) => received.push(event));

    // Now release the driver so the run completes.
    stages[0]?.();
    await waitFor(async () => {
      const c = await runtime.getConversation(conversation.id);
      return c?.runs[0].status === "completed" ? true : undefined;
    });
    unsubscribe();

    // None of the events received should have a sequence <= cursor.
    expect(received.every((event) => event.sequence > cursor)).toBe(true);
    // We should still receive the third delta and run_completed.
    expect(received.some((event) => event.type === "text_delta" && event.text === "c")).toBe(true);
    expect(received.some((event) => event.type === "run_completed")).toBe(true);
  });
});
