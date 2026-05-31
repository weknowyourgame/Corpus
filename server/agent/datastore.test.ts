// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCloudClient, redactValue } from "./open-cloud.ts";
import { createDataStoreTools } from "./datastore-tools.ts";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import type {
  AgentEvent,
  AgentTool,
  AgentToolRegistry,
  ModelDriverFactory,
  ToolExecutionContext,
} from "./types.ts";

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for state");
};

const makeContext = (): ToolExecutionContext => ({
  conversationId: "c1",
  runId: "r1",
  operationId: "op1",
  studioSessionId: "s1",
  signal: new AbortController().signal,
  requestInteraction: async () => [],
});

const mockedClient = (overrides: Partial<OpenCloudClient> & { configured?: boolean } = {}) => {
  const base: Record<string, unknown> = {
    universeId: "universe-123",
    configured: true,
    listStores: vi.fn().mockResolvedValue([]),
    listKeys: vi.fn().mockResolvedValue([]),
    readKey: vi.fn().mockResolvedValue({ value: null }),
    writeKey: vi.fn().mockResolvedValue({ version: "v1" }),
    deleteKey: vi.fn().mockResolvedValue(undefined),
    incrementKey: vi.fn().mockResolvedValue({ value: 1 }),
  };
  return { ...base, ...overrides } as unknown as OpenCloudClient & Record<string, ReturnType<typeof vi.fn>>;
};

const registry = (tools: AgentTool[]): AgentToolRegistry => ({
  list: () => tools,
  get: (name) => tools.find((t) => t.name === name),
});

describe("redactValue", () => {
  it("returns short plain strings unchanged", () => {
    expect(redactValue("hello world")).toBe("hello world");
  });

  it("redacts strings over the size threshold", () => {
    const val = "x".repeat(600);
    expect(redactValue(val)).toBe("[REDACTED: 600 chars]");
  });

  it("does not redact at exactly 500 chars", () => {
    expect(redactValue("y".repeat(500))).toBe("y".repeat(500));
  });

  it("redacts strings just over the threshold", () => {
    expect(redactValue("z".repeat(501))).toBe("[REDACTED: 501 chars]");
  });

  it("redacts known sensitive JSON keys", () => {
    const json = JSON.stringify({ user: "alice", password: "hunter2", token: "abcd", nested: { secret: "xyz" } });
    const result = redactValue(json);
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("abcd");
    expect(result).not.toContain("xyz");
    expect(result).toContain("alice");
  });

  it("redacts email and token-like patterns in plain strings", () => {
    const val = "Player a@example.com used sk-AAAAAAAAAAAAAAAAAAAAAAAAAA1234567890";
    const out = redactValue(val);
    expect(out).not.toContain("a@example.com");
    expect(out).not.toContain("sk-AAAAAAAAAAAAAAAAAAAAAAAAAA1234567890");
    expect(out).toContain("[REDACTED:email]");
    expect(out).toContain("[REDACTED:token]");
  });
});

describe("DataStore tools — unconfigured", () => {
  it("reads return a structured not-configured error", async () => {
    const client = new OpenCloudClient();
    Object.defineProperty(client, "configured", { get: () => false });
    const [listStores, listKeys, readKey] = createDataStoreTools(client);
    const ctx = makeContext();
    for (const tool of [listStores, listKeys, readKey]) {
      const result = await tool.execute({ store: "S", key: "K" }, ctx);
      expect(result).toMatchObject({ code: "open_cloud_not_configured" });
    }
  });

  it("mutations return not-configured without contacting the API", async () => {
    const client = new OpenCloudClient();
    Object.defineProperty(client, "configured", { get: () => false });
    const tools = createDataStoreTools(client);
    const write = tools.find((t) => t.name === "roblox_datastore__write_key")!;
    const result = await write.execute(
      { environment: "development", store: "Scores", scope: "global", key: "p1", value: "100" },
      makeContext(),
    );
    expect(result).toMatchObject({ code: "open_cloud_not_configured" });
  });
});

describe("DataStore tools — previews", () => {
  it("write preview includes universe, env, store, scope, key, old/new redacted values and rollback note", async () => {
    const client = mockedClient({
      readKey: vi.fn().mockResolvedValue({ value: "old-data" }),
    } as Partial<OpenCloudClient>);
    const write = createDataStoreTools(client).find((t) => t.name === "roblox_datastore__write_key")!;
    const preview = await write.preview!(
      { environment: "development", store: "Scores", scope: "global", key: "p1", value: "new-data" },
      makeContext(),
    );
    expect(preview).toMatchObject({
      operation: "write",
      environment: "development",
      universe: "universe-123",
      store: "Scores",
      scope: "global",
      key: "p1",
      oldValue: "old-data",
      newValue: "new-data",
      elevated: false,
      rollback: expect.stringContaining("DataStore"),
    });
  });

  it("production write preview is marked elevated", async () => {
    const client = mockedClient();
    const write = createDataStoreTools(client).find((t) => t.name === "roblox_datastore__write_key")!;
    const preview = (await write.preview!(
      { environment: "production", store: "Scores", scope: "global", key: "p1", value: "v" },
      makeContext(),
    )) as Record<string, unknown>;
    expect(preview.elevated).toBe(true);
    expect(preview.environment).toBe("production");
  });

  it("isElevated reports true for production-targeted mutations", () => {
    const tools = createDataStoreTools(mockedClient());
    for (const name of [
      "roblox_datastore__write_key",
      "roblox_datastore__delete_key",
      "roblox_datastore__increment_key",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(
        tool.isElevated!({ environment: "production", store: "S", scope: "g", key: "k", value: "v", delta: 1 }),
      ).toBe(true);
      expect(
        tool.isElevated!({ environment: "development", store: "S", scope: "g", key: "k", value: "v", delta: 1 }),
      ).toBe(false);
    }
  });

  it("redactInput strips raw value for audit/event safety", () => {
    const write = createDataStoreTools(mockedClient()).find((t) => t.name === "roblox_datastore__write_key")!;
    const huge = "x".repeat(2000);
    const safe = write.redactInput!({
      environment: "production",
      store: "Players",
      scope: "global",
      key: "p1",
      value: huge,
    });
    expect(safe).toMatchObject({
      environment: "production",
      store: "Players",
      key: "p1",
      valueBytes: 2000,
    });
    expect(JSON.stringify(safe)).not.toContain(huge);
    expect((safe as Record<string, unknown>).valuePreview).toBe("[REDACTED: 2000 chars]");
  });
});

describe("DataStore tools — read configuration enforcement", () => {
  it("read_key requires configured credentials", async () => {
    const unconfigured = new OpenCloudClient();
    Object.defineProperty(unconfigured, "configured", { get: () => false });
    const tools = createDataStoreTools(unconfigured);
    const read = tools.find((t) => t.name === "roblox_datastore__read_key")!;
    const result = await read.execute({ store: "S", scope: "global", key: "K" }, makeContext());
    expect(result).toMatchObject({ code: "open_cloud_not_configured" });
  });

  it("read_key returns redacted values when configured", async () => {
    const huge = "y".repeat(2000);
    const client = mockedClient({ readKey: vi.fn().mockResolvedValue({ value: huge, version: "v3" }) } as Partial<OpenCloudClient>);
    const read = createDataStoreTools(client).find((t) => t.name === "roblox_datastore__read_key")!;
    const result = (await read.execute({ store: "S", scope: "global", key: "K" }, makeContext())) as Record<string, unknown>;
    expect(result.value).toBe("[REDACTED: 2000 chars]");
    expect(result.bytes).toBe(2000);
    expect(result.version).toBe("v3");
    expect(JSON.stringify(result)).not.toContain(huge);
  });
});

describe("DataStore tools — runtime approval flow", () => {
  beforeEach(() => {
    process.env.ROBLOX_OPEN_CLOUD_API_KEY = "test-key-RBXNEVER-LEAK-INTO-EVENTS";
    process.env.ROBLOX_UNIVERSE_ID = "universe-123";
  });

  afterEach(() => {
    delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    delete process.env.ROBLOX_UNIVERSE_ID;
  });

  const buildRuntime = (tools: AgentTool[], turnPlan: (turn: number) => { text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }) => {
    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        return turnPlan(turn);
      },
    });
    return new AgentRuntime(new MemoryConversationStore(), factory, registry(tools));
  };

  it("approved write executes exactly once through the runtime", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const writeCallId = "call-write";
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: writeCallId,
                name: "roblox_datastore__write_key",
                input: { environment: "development", store: "Scores", scope: "global", key: "p1", value: "100" },
              },
            ],
          }
        : { text: "done.", toolCalls: [] },
    );

    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending"));
    expect(pending.type).toBe("approval_pending");
    expect(client.writeKey).toHaveBeenCalledTimes(0);

    if (pending.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "allow_once");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);

    expect(client.writeKey).toHaveBeenCalledTimes(1);
    expect(client.writeKey).toHaveBeenCalledWith("Scores", "global", "p1", "100", expect.any(Object));
  });

  it("denied write executes zero times", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "roblox_datastore__write_key",
                input: { environment: "development", store: "Scores", scope: "global", key: "p1", value: "100" },
              },
            ],
          }
        : { text: "ok", toolCalls: [] },
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "deny");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(client.writeKey).toHaveBeenCalledTimes(0);
  });

  it("delete and increment also require approval", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              { id: "del", name: "roblox_datastore__delete_key", input: { environment: "development", store: "S", scope: "global", key: "k" } },
              { id: "inc", name: "roblox_datastore__increment_key", input: { environment: "development", store: "S", scope: "global", key: "k", delta: 1 } },
            ],
          }
        : { text: "ok", toolCalls: [] },
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const firstApproval = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending" && e.toolName === "roblox_datastore__delete_key"));
    if (firstApproval.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, firstApproval.approvalId, "deny");

    const secondApproval = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending" && e.toolName === "roblox_datastore__increment_key"));
    if (secondApproval.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, secondApproval.approvalId, "allow_once");

    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(client.deleteKey).toHaveBeenCalledTimes(0);
    expect(client.incrementKey).toHaveBeenCalledTimes(1);
  });

  it("production writes flag the approval as elevated", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "p1",
                name: "roblox_datastore__write_key",
                input: { environment: "production", store: "S", scope: "global", key: "k", value: "v" },
              },
            ],
          }
        : { text: "ok", toolCalls: [] },
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("unreachable");
    expect(pending.elevated).toBe(true);
    const preview = pending.preview as Record<string, unknown>;
    expect(preview.elevated).toBe(true);
    expect(preview.environment).toBe("production");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "deny");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
  });

  it("redacts sensitive values in tool_call/approval_pending events and audit", async () => {
    const huge = "x".repeat(2000);
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "w1",
                name: "roblox_datastore__write_key",
                input: { environment: "development", store: "S", scope: "global", key: "k", value: huge },
              },
            ],
          }
        : { text: "done", toolCalls: [] },
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "allow_once");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);

    const final = await runtime.getConversation(conversation.id);
    const eventsJson = JSON.stringify(final?.events ?? []);
    const auditJson = JSON.stringify(final?.auditEvents ?? []);
    const messagesJson = JSON.stringify(final?.messages ?? []);
    expect(eventsJson).not.toContain(huge);
    expect(auditJson).not.toContain(huge);
    expect(messagesJson).not.toContain(huge);
  });

  it("never leaks ROBLOX_OPEN_CLOUD_API_KEY into events, audit or messages", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const runtime = buildRuntime(tools, (turn) =>
      turn === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "w2",
                name: "roblox_datastore__write_key",
                input: { environment: "development", store: "S", scope: "global", key: "k", value: "v" },
              },
            ],
          }
        : { text: "done", toolCalls: [] },
    );
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((e) => e.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "allow_once");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);

    const final = await runtime.getConversation(conversation.id);
    const key = process.env.ROBLOX_OPEN_CLOUD_API_KEY!;
    expect(key.length).toBeGreaterThan(8);
    const everything = JSON.stringify({
      events: final?.events,
      audit: final?.auditEvents,
      messages: final?.messages,
    });
    expect(everything).not.toContain(key);
  });
});

describe("OpenCloudClient — error masking", () => {
  it("never echoes the api key in raised error messages", async () => {
    const realFetch = globalThis.fetch;
    process.env.ROBLOX_OPEN_CLOUD_API_KEY = "rbx-supersecret-key-do-not-leak-1234567890";
    process.env.ROBLOX_UNIVERSE_ID = "u";
    const client = new OpenCloudClient();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `request failed with header x-api-key=${process.env.ROBLOX_OPEN_CLOUD_API_KEY}`,
    }) as typeof fetch;
    try {
      await expect(client.readKey("S", "global", "k")).rejects.toThrowError(/REDACTED/);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
      delete process.env.ROBLOX_UNIVERSE_ID;
    }
  });
});

describe("DataStore tools — event payload shape after approval (regression)", () => {
  it("tool_result for an approved write returns redacted ok payload", async () => {
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    const tool = tools.find((t) => t.name === "roblox_datastore__write_key")!;
    const result = await tool.execute(
      { environment: "development", store: "Scores", scope: "global", key: "p1", value: "100" },
      makeContext(),
    );
    expect(result).toMatchObject({
      ok: true,
      operation: "write",
      environment: "development",
      version: "v1",
      valueBytes: 3,
    });
  });
});

describe("DataStore tools — observable events do not contain secrets", () => {
  it("events streamed via subscribe carry redacted inputs only", async () => {
    process.env.ROBLOX_OPEN_CLOUD_API_KEY = "secret-key-AAAA";
    process.env.ROBLOX_UNIVERSE_ID = "u-1";
    const client = mockedClient();
    const tools = createDataStoreTools(client);
    let turn = 0;
    const huge = "secret-player-data".repeat(50);
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        return turn === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "w",
                  name: "roblox_datastore__write_key",
                  input: { environment: "development", store: "S", scope: "global", key: "k", value: huge },
                },
              ],
            }
          : { text: "ok", toolCalls: [] };
      },
    });
    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, registry(tools));
    const observed: AgentEvent[] = [];
    const conversation = await runtime.createConversation("ABCDEF12");
    const unsubscribe = await runtime.subscribe(conversation.id, 0, (e) => observed.push(e));
    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => observed.find((e) => e.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("unreachable");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "allow_once");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    unsubscribe();
    const observedJson = JSON.stringify(observed);
    expect(observedJson).not.toContain(huge);
    expect(observedJson).not.toContain("secret-key-AAAA");
    delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    delete process.env.ROBLOX_UNIVERSE_ID;
  });
});
