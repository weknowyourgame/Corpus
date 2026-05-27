// @vitest-environment node
import { describe, expect, it } from "vitest";
import { executeBatches, planBatches } from "./scheduler.ts";
import type { AgentTool, AgentToolCall, AgentToolRegistry, JsonValue } from "./types.ts";

const tool = (name: string, concurrency: AgentTool["concurrency"]): AgentTool => ({
  name,
  description: name,
  transport: "studio_mcp",
  risk: concurrency === "parallel_read" ? "read" : "low_mutation",
  concurrency,
  inputSchema: {},
  scope: () => name,
  execute: async () => ({ ok: true } as JsonValue),
});

const registry = (tools: AgentTool[]): AgentToolRegistry => ({
  list: () => tools,
  get: (name) => tools.find((item) => item.name === name),
});

const call = (id: string, name: string): AgentToolCall => ({ id, name, input: {} });

describe("planBatches", () => {
  it("packs consecutive parallel_read tools into a single batch", () => {
    const reg = registry([
      tool("read_a", "parallel_read"),
      tool("read_b", "parallel_read"),
      tool("read_c", "parallel_read"),
    ]);
    const batches = planBatches([call("1", "read_a"), call("2", "read_b"), call("3", "read_c")], reg);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("breaks the batch when an exclusive_mutation tool appears", () => {
    const reg = registry([
      tool("read_a", "parallel_read"),
      tool("write_a", "exclusive_mutation"),
      tool("read_b", "parallel_read"),
    ]);
    const batches = planBatches(
      [call("1", "read_a"), call("2", "write_a"), call("3", "read_b")],
      reg,
    );
    expect(batches.map((b) => b.map((c) => c.id))).toEqual([["1"], ["2"], ["3"]]);
  });

  it("schedules unknown tools as exclusive batches", () => {
    const reg = registry([tool("read_a", "parallel_read")]);
    const batches = planBatches([call("1", "read_a"), call("2", "unknown")], reg);
    expect(batches).toHaveLength(2);
    expect(batches[1][0].name).toBe("unknown");
  });
});

describe("executeBatches", () => {
  it("runs parallel reads concurrently", async () => {
    const reg = registry([
      tool("read_a", "parallel_read"),
      tool("read_b", "parallel_read"),
    ]);
    let inFlight = 0;
    let peak = 0;
    const exec = async (c: AgentToolCall): Promise<JsonValue> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { id: c.id };
    };
    const outcomes = await executeBatches(
      [call("1", "read_a"), call("2", "read_b")],
      reg,
      exec,
      new AbortController().signal,
    );
    expect(peak).toBe(2);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["1", "2"]);
  });

  it("runs mutations strictly sequentially", async () => {
    const reg = registry([
      tool("write_a", "exclusive_mutation"),
      tool("write_b", "exclusive_mutation"),
    ]);
    let inFlight = 0;
    let peak = 0;
    const exec = async (c: AgentToolCall): Promise<JsonValue> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { id: c.id };
    };
    const outcomes = await executeBatches(
      [call("1", "write_a"), call("2", "write_b")],
      reg,
      exec,
      new AbortController().signal,
    );
    expect(peak).toBe(1);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["1", "2"]);
  });

  it("returns cancellation outcomes for unscheduled batches when aborted", async () => {
    const reg = registry([
      tool("write_a", "exclusive_mutation"),
      tool("write_b", "exclusive_mutation"),
    ]);
    const controller = new AbortController();
    const exec = async (c: AgentToolCall): Promise<JsonValue> => {
      controller.abort();
      return { id: c.id };
    };
    const outcomes = await executeBatches(
      [call("1", "write_a"), call("2", "write_b"), call("3", "write_a")],
      reg,
      exec,
      controller.signal,
    );
    expect(outcomes[0].output).toEqual({ id: "1" });
    expect((outcomes[1].output as Record<string, unknown>).cancelled).toBe(true);
    expect((outcomes[2].output as Record<string, unknown>).cancelled).toBe(true);
  });

  it("preserves model order in returned outcomes even when reads finish out of order", async () => {
    const reg = registry([
      tool("read_a", "parallel_read"),
      tool("read_b", "parallel_read"),
      tool("read_c", "parallel_read"),
    ]);
    const delays: Record<string, number> = { "1": 30, "2": 5, "3": 15 };
    const exec = async (c: AgentToolCall): Promise<JsonValue> => {
      await new Promise((resolve) => setTimeout(resolve, delays[c.id]));
      return { id: c.id };
    };
    const outcomes = await executeBatches(
      [call("1", "read_a"), call("2", "read_b"), call("3", "read_c")],
      reg,
      exec,
      new AbortController().signal,
    );
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["1", "2", "3"]);
  });
});
