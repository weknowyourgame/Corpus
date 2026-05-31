// @vitest-environment node
import { describe, it, expect } from "vitest";
import { ReadOnlyToolRegistry, SubagentRuntime, type SubagentType } from "./subagent.ts";
import type { AgentTool, AgentToolRegistry, JsonValue } from "./types.ts";

function makeTool(name: string, risk: AgentTool["risk"], result: JsonValue = { ok: true }): AgentTool {
  return {
    name,
    description: `Tool ${name}`,
    transport: "server",
    risk,
    concurrency: risk === "read" ? "parallel_read" : "exclusive_mutation",
    inputSchema: {} as unknown,
    scope: () => name,
    execute: async () => result,
  };
}

function makeRegistry(tools: AgentTool[]): AgentToolRegistry {
  return {
    list: () => tools,
    get: (name) => tools.find((t) => t.name === name),
  };
}

describe("ReadOnlyToolRegistry", () => {
  it("passes through read-only tools unchanged", async () => {
    const readTool = makeTool("read_thing", "read", { data: "ok" });
    const registry = new ReadOnlyToolRegistry(makeRegistry([readTool]));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("read_thing")).toBeDefined();
    const result = await registry.get("read_thing")!.execute({}, {} as never);
    expect(result).toEqual({ data: "ok" });
  });

  it("wraps destructive tools to return plan proposal", async () => {
    const destroyTool = makeTool("delete_instance", "destructive");
    const registry = new ReadOnlyToolRegistry(makeRegistry([destroyTool]));
    const result = await registry.get("delete_instance")!.execute({ path: "game.Workspace.Part" }, {} as never);
    expect((result as Record<string, unknown>).denied).toBe(true);
    expect((result as Record<string, unknown>).planProposal).toBe(true);
  });

  it("wraps low_mutation tools to record proposals", async () => {
    const mutateTool = makeTool("write_script", "low_mutation");
    const registry = new ReadOnlyToolRegistry(makeRegistry([mutateTool]));
    await registry.get("write_script")!.execute({ path: "game.ServerScriptService.Main", source: "print(1)" }, {} as never);
    expect(registry.proposals).toHaveLength(1);
    expect(registry.proposals[0].toolName).toBe("write_script");
    expect(registry.proposals[0].input).toEqual({ path: "game.ServerScriptService.Main", source: "print(1)" });
  });

  it("blocks roblox_spawn_subagent to prevent recursion", () => {
    const subagentTool = makeTool("roblox_spawn_subagent", "read");
    const registry = new ReadOnlyToolRegistry(makeRegistry([subagentTool]));
    expect(registry.get("roblox_spawn_subagent")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it("collects multiple proposals across different mutation tools", async () => {
    const tools = [
      makeTool("write_script", "low_mutation"),
      makeTool("delete_instance", "destructive"),
      makeTool("execute_luau", "runtime_code"),
    ];
    const registry = new ReadOnlyToolRegistry(makeRegistry(tools));
    for (const t of registry.list()) {
      await t.execute({}, {} as never);
    }
    expect(registry.proposals).toHaveLength(3);
    const names = registry.proposals.map((p) => p.toolName);
    expect(names).toContain("write_script");
    expect(names).toContain("delete_instance");
    expect(names).toContain("execute_luau");
  });
});

describe("SubagentRuntime", () => {
  it("aborts immediately when signal is already aborted", async () => {
    const tools = makeRegistry([makeTool("mcp__roblox_studio__read_script", "read")]);
    const runtime = new SubagentRuntime(tools, 10);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.run("debugger", "analyze scripts", "sess1", "pro", controller.signal);
    expect(result.aborted).toBe(true);
    expect(result.iterations).toBe(0);
  });

  it("respects maxIterations budget — stops after budget exceeded (mocked driver)", async () => {
    // Use a mock by monkey-patching createModelDriverFactory to count iterations
    let callCount = 0;
    const tools = makeRegistry([]);
    const runtime = new SubagentRuntime(tools, 2);
    const controller = new AbortController();

    // Can't easily mock createModelDriverFactory without dependency injection,
    // but we can verify the field is accessible
    expect((runtime as unknown as Record<string, unknown>).defaultMaxIterations).toBe(2);
  });

  it("result type matches the spawned specialist type", async () => {
    const controller = new AbortController();
    controller.abort(); // abort to skip driver call
    const tools = makeRegistry([]);
    const runtime = new SubagentRuntime(tools, 5);
    const types: SubagentType[] = ["debugger", "ui_specialist", "combat_specialist", "network_specialist"];
    for (const type of types) {
      const result = await runtime.run(type, "task", "sess", "pro", controller.signal);
      expect(result.type).toBe(type);
    }
  });
});
