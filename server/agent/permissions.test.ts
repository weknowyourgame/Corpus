// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import type { AgentTool, AgentToolRegistry, ModelDriverFactory } from "./types.ts";

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for event");
};

const mutationTool = (executions: Record<string, unknown>[]): AgentTool => ({
  name: "mcp__roblox_studio__create_instance",
  description: "create",
  transport: "studio_mcp",
  risk: "low_mutation",
  concurrency: "exclusive_mutation",
  inputSchema: {},
  scope: (input) => `${String(input.parent)}/${String(input.name)}`,
  execute: async (input) => {
    executions.push(input);
    return { created: String(input.name) };
  },
});

const registry = (tool: AgentTool): AgentToolRegistry => ({
  list: () => [tool],
  get: (name) => name === tool.name ? tool : undefined,
});

describe("permission enforcement", () => {
  it("does not execute a mutating MCP tool until approval is returned", async () => {
    const executions: Record<string, unknown>[] = [];
    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        return turn === 1
          ? { text: "", toolCalls: [{ id: "change-1", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", name: "Plot" } }] }
          : { text: "Created.", toolCalls: [] };
      },
    });
    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, registry(mutationTool(executions)));
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "Create", tier: "pro" });
    const approval = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events
      .find((event) => event.type === "approval_pending"));

    expect(executions).toHaveLength(0);
    if (approval.type !== "approval_pending") throw new Error("Missing approval");
    await runtime.answerApproval(conversation.id, run.id, approval.approvalId, "allow_once");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(executions).toHaveLength(1);
  });

  it("pauses again when an approved scope expands to a second target", async () => {
    const executions: Record<string, unknown>[] = [];
    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) return { text: "", toolCalls: [{ id: "first", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", name: "Allowed" } }] };
        if (turn === 2) return { text: "", toolCalls: [{ id: "second", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", name: "Expanded" } }] };
        return { text: "Finished.", toolCalls: [] };
      },
    });
    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, registry(mutationTool(executions)));
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "Build", tier: "pro" });
    const first = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events
      .find((event) => event.type === "approval_pending"));
    if (first.type !== "approval_pending") throw new Error("Missing first approval");
    await runtime.answerApproval(conversation.id, run.id, first.approvalId, "allow_scope");
    const second = await waitFor(async () => {
      const events = (await runtime.getConversation(conversation.id))?.events.filter((event) => event.type === "approval_pending") ?? [];
      return events[1];
    });

    expect(executions).toHaveLength(1);
    if (second.type !== "approval_pending") throw new Error("Missing expanded approval");
    await runtime.answerApproval(conversation.id, run.id, second.approvalId, "deny");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(executions).toHaveLength(1);
  });

  it("reuses an approved create-instance scope for another instance under the same parent and class", async () => {
    const executions: Record<string, unknown>[] = [];
    const scopedCreate = {
      ...mutationTool(executions),
      scope: (input: Record<string, unknown>) => `${String(input.parent)}/*:${String(input.className)}`,
    };
    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) return { text: "", toolCalls: [{ id: "first", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", className: "Part", name: "A" } }] };
        if (turn === 2) return { text: "", toolCalls: [{ id: "second", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", className: "Part", name: "B" } }] };
        return { text: "Finished.", toolCalls: [] };
      },
    });
    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, registry(scopedCreate));
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "Build", tier: "pro" });
    const first = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events
      .find((event) => event.type === "approval_pending"));
    if (first.type !== "approval_pending") throw new Error("Missing first approval");
    await runtime.answerApproval(conversation.id, run.id, first.approvalId, "allow_scope");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    const saved = await runtime.getConversation(conversation.id);

    expect(executions).toHaveLength(2);
    expect(saved?.events.filter((event) => event.type === "approval_pending")).toHaveLength(1);
  });

  it("returns a structured denial for mutations requested during plan mode", async () => {
    const executions: Record<string, unknown>[] = [];
    let turn = 0;
    const runtime = new AgentRuntime(new MemoryConversationStore(), () => ({
      generate: async (input) => {
        turn += 1;
        if (turn === 1) return { text: "", toolCalls: [{ id: "blocked", name: "mcp__roblox_studio__create_instance", input: { parent: "game.Workspace", name: "Nope" } }] };
        expect(input.messages.at(-1)).toMatchObject({ role: "tool", output: { denied: true } });
        return { text: "Plan only.", toolCalls: [] };
      },
    }), registry(mutationTool(executions)));
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Plan", tier: "pro", mode: "plan" });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    const saved = await runtime.getConversation(conversation.id);

    expect(executions).toHaveLength(0);
    expect(saved?.events.some((event) => event.type === "approval_pending")).toBe(false);
    expect(saved?.events.some((event) => event.type === "plan_proposed")).toBe(true);
  });
});
