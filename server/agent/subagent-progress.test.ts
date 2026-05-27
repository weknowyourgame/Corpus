// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SubagentRuntime, type SubagentType } from "./subagent.ts";
import type { AgentTool, AgentToolRegistry, SubagentProgressEvent } from "./types.ts";

const makeTool = (name: string, risk: AgentTool["risk"]): AgentTool => ({
  name,
  description: name,
  transport: "studio_mcp",
  risk,
  concurrency: risk === "read" ? "parallel_read" : "exclusive_mutation",
  inputSchema: {},
  scope: () => name,
  execute: async () => ({ ok: true }),
});

const makeRegistry = (tools: AgentTool[]): AgentToolRegistry => ({
  list: () => tools,
  get: (name) => tools.find((t) => t.name === name),
});

describe("SubagentRuntime progress + cancellation", () => {
  it("emits a started progress event before driver execution", async () => {
    const events: SubagentProgressEvent[] = [];
    const controller = new AbortController();
    controller.abort(); // abort so driver is never called
    const runtime = new SubagentRuntime(makeRegistry([makeTool("mcp__roblox_studio__read_script", "read")]), 5);
    const result = await runtime.run("debugger" as SubagentType, "task", "sess", "anthropic", "model", controller.signal, {
      onProgress: (event) => { events.push(event); },
    });
    expect(events[0]?.kind).toBe("started");
    expect(events.at(-1)?.kind).toBe("cancelled");
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("threads the budgetMs option through to the result without touching the model driver when the signal is already aborted", async () => {
    const events: SubagentProgressEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const runtime = new SubagentRuntime(makeRegistry([]), 5);
    const result = await runtime.run("debugger" as SubagentType, "task", "sess", "anthropic", "model", controller.signal, {
      onProgress: (event) => { events.push(event); },
      budgetMs: 100,
    });
    // Aborted before any iteration ran — no timeout, just an abort.
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(events.some((event) => event.kind === "started")).toBe(true);
  });

  it("does not crash when onProgress throws", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new SubagentRuntime(makeRegistry([]), 5);
    const result = await runtime.run("debugger" as SubagentType, "task", "sess", "anthropic", "model", controller.signal, {
      onProgress: () => { throw new Error("boom"); },
    });
    expect(result.aborted).toBe(true);
  });
});
