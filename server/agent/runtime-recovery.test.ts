// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolRegistry,
  JsonValue,
  ModelDriverFactory,
} from "./types.ts";

const waitFor = async (test: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for runtime state");
};

const toolCall = (name: string, input: Record<string, unknown>): AgentToolCall => ({
  id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  input,
});

const registryFrom = (tools: AgentTool[]): AgentToolRegistry => ({
  list: () => tools,
  get: (name) => tools.find((tool) => tool.name === name),
});

const userMessages = (messages: AgentMessage[]) =>
  messages.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user");

describe("AgentRuntime tool-failure recovery", () => {
  it("repairs a failed Color3 set_property and verifies before completing", async () => {
    const setCalls: unknown[] = [];
    let verified = false;
    const setProperty: AgentTool = {
      name: "mcp__roblox_studio__set_property",
      description: "set",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: {},
      scope: (input) => `game.${input.path}.${input.property}`,
      execute: async (input) => {
        setCalls.push(input.value);
        if (input.value === "Color3.fromRGB(40, 40, 50)") {
          return { success: false, error: "Color3 expected, got string" } as JsonValue;
        }
        if (input.value === "40, 40, 50") return { success: true, path: input.path } as JsonValue;
        return { success: false, error: "unexpected value" } as JsonValue;
      },
    };
    const getProperties: AgentTool = {
      name: "mcp__roblox_studio__get_properties",
      description: "get",
      transport: "studio_mcp",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: {},
      scope: (input) => String(input.path),
      execute: async () => {
        verified = true;
        return { success: true, properties: { FogColor: "40, 40, 50" } } as JsonValue;
      },
    };

    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [toolCall("mcp__roblox_studio__set_property", {
              path: "Lighting",
              property: "FogColor",
              value: "Color3.fromRGB(40, 40, 50)",
            })],
          };
        }
        return { text: "Done.", toolCalls: [] };
      },
    });

    const runtime = new AgentRuntime(
      new MemoryConversationStore(),
      factory,
      registryFrom([setProperty, getProperties]),
      10,
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Set fog", tier: "pro", fullAccess: true });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");

    const saved = await runtime.getConversation(conversation.id);
    expect(saved?.runs[0].status).toBe("completed");
    // original bad value, then the auto-repaired plugin-format value
    expect(setCalls).toEqual(["Color3.fromRGB(40, 40, 50)", "40, 40, 50"]);
    expect(verified).toBe(true);
    // No unresolved-failure correction should have been injected — recovery handled it.
    expect(userMessages(saved!.messages).some((m) => m.content.includes("UNRESOLVED"))).toBe(false);
  }, 20000);

  it("carries an unrecoverable failure into the next iteration and blocks completion", async () => {
    let createCount = 0;
    const create: AgentTool = {
      name: "mcp__roblox_studio__create_instance",
      description: "create",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: {},
      scope: (input) => `${input.parent}/*:${input.className}`,
      execute: async () => {
        createCount += 1;
        if (createCount === 1) return { success: false, error: "internal plugin error" } as JsonValue;
        return { success: true, path: "game.ReplicatedStorage.Thing" } as JsonValue;
      },
    };

    let sawCorrection = false;
    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async (input) => {
        turn += 1;
        const call = () => toolCall("mcp__roblox_studio__create_instance", {
          parent: "game.ReplicatedStorage",
          className: "Folder",
          name: "Thing",
        });
        if (turn === 1) return { text: "", toolCalls: [call()] };
        if (turn === 2) return { text: "All set.", toolCalls: [] }; // tries to finish — should be blocked
        if (turn === 3) {
          // The runtime should have reinjected the unresolved failure as a user task.
          const last = input.messages.at(-1);
          sawCorrection = last?.role === "user" && last.content.includes("UNRESOLVED");
          return { text: "", toolCalls: [call()] }; // retry, this time succeeds
        }
        return { text: "Done.", toolCalls: [] };
      },
    });

    const runtime = new AgentRuntime(
      new MemoryConversationStore(),
      factory,
      registryFrom([create]),
      10,
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Make a folder", tier: "pro", fullAccess: true });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");

    const saved = await runtime.getConversation(conversation.id);
    expect(saved?.runs[0].status).toBe("completed");
    expect(sawCorrection).toBe(true);
    expect(createCount).toBe(2);
    // The injected correction message must list the failed obligation.
    const corrections = userMessages(saved!.messages).filter((m) => m.content.includes("UNRESOLVED"));
    expect(corrections.length).toBe(1);
    expect(corrections[0].content).toContain("create_instance");
  }, 20000);

  it("stops blocking completion after the retry cap and completes", async () => {
    const create: AgentTool = {
      name: "mcp__roblox_studio__create_instance",
      description: "create",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: {},
      scope: (input) => `${input.parent}/*:${input.className}`,
      execute: async () => ({ success: false, error: "permanently broken" }) as JsonValue,
    };

    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [toolCall("mcp__roblox_studio__create_instance", {
              parent: "game.ReplicatedStorage",
              className: "Folder",
            })],
          };
        }
        // Model refuses to fix it — keeps trying to finish.
        return { text: "I cannot fix this.", toolCalls: [] };
      },
    });

    const maxNags = 2;
    const runtime = new AgentRuntime(
      new MemoryConversationStore(),
      factory,
      registryFrom([create]),
      20,
      undefined,
      2,
      maxNags,
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Make a folder", tier: "pro", fullAccess: true });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");

    const saved = await runtime.getConversation(conversation.id);
    // Completes despite the unresolved failure — the cap prevents an infinite loop.
    expect(saved?.runs[0].status).toBe("completed");
    const corrections = userMessages(saved!.messages).filter((m) => m.content.includes("UNRESOLVED"));
    expect(corrections.length).toBe(maxNags);
  }, 20000);

  it("registers an obligation when every repair attempt also fails", async () => {
    let turn = 0;
    const setProperty: AgentTool = {
      name: "mcp__roblox_studio__set_property",
      description: "set",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: {},
      scope: (input) => `game.${input.path}.${input.property}`,
      execute: async () => ({ success: false, error: "Color3 expected, got string" }) as JsonValue,
    };
    const executeLuau: AgentTool = {
      name: "mcp__roblox_studio__execute_luau",
      description: "luau",
      transport: "studio_mcp",
      risk: "low_mutation", // keep auto-allowed under fullAccess for this test
      concurrency: "exclusive_mutation",
      inputSchema: {},
      scope: () => "runtime-code",
      execute: async () => ({ success: false, error: "still broken" }) as JsonValue,
    };
    const getProperties: AgentTool = {
      name: "mcp__roblox_studio__get_properties",
      description: "get",
      transport: "studio_mcp",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: {},
      scope: (input) => String(input.path),
      execute: async () => ({ success: true }) as JsonValue,
    };

    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [toolCall("mcp__roblox_studio__set_property", {
              path: "Lighting",
              property: "FogColor",
              value: "Color3.fromRGB(40, 40, 50)",
            })],
          };
        }
        return { text: "Cannot fix.", toolCalls: [] };
      },
    });

    const runtime = new AgentRuntime(
      new MemoryConversationStore(),
      factory,
      registryFrom([setProperty, executeLuau, getProperties]),
      10,
      undefined,
      2,
      1,
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    await runtime.startRun(conversation.id, { message: "Set fog", tier: "pro", fullAccess: true });
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed");

    const saved = await runtime.getConversation(conversation.id);
    // Both the repaired retry and the execute_luau fallback failed → obligation stands,
    // so the run was nagged before finally completing at the cap.
    const corrections = userMessages(saved!.messages).filter((m) => m.content.includes("UNRESOLVED"));
    expect(corrections.length).toBe(1);
    expect(corrections[0].content).toContain("set_property");
  }, 20000);
});
