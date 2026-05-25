// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { redactValue, OpenCloudClient } from "./open-cloud.ts";
import { createDataStoreTools } from "./datastore-tools.ts";
import type { DataStoreApprovalRequest, ToolExecutionContext } from "./types.ts";

describe("redactValue", () => {
  it("returns value unchanged when short", () => {
    const val = "hello world";
    expect(redactValue(val)).toBe(val);
  });

  it("returns REDACTED marker for 600-char string", () => {
    const val = "x".repeat(600);
    const result = redactValue(val);
    expect(result).toContain("[REDACTED:");
    expect(result).toContain("600 chars");
    expect(result).not.toBe(val);
  });

  it("does not redact exactly 500 chars", () => {
    const val = "y".repeat(500);
    expect(redactValue(val)).toBe(val);
  });

  it("redacts 501 chars", () => {
    const val = "z".repeat(501);
    expect(redactValue(val)).toContain("[REDACTED:");
  });
});

describe("DataStore tools - not configured", () => {
  it("returns error when client not configured", async () => {
    const client = new OpenCloudClient();
    // Override configured to be false
    Object.defineProperty(client, "configured", { get: () => false });

    const tools = createDataStoreTools(client, async () => "allow_once");
    const listTool = tools.find((t) => t.name === "roblox_datastore__list_stores");
    expect(listTool).toBeDefined();

    const ctx = {
      conversationId: "c1",
      runId: "r1",
      operationId: "op1",
      studioSessionId: "s1",
      signal: new AbortController().signal,
      requestInteraction: async () => [],
    } as ToolExecutionContext;

    const result = await listTool!.execute({}, ctx);
    expect(result).toMatchObject({ error: expect.stringContaining("Open Cloud not configured") });
  });
});

describe("DataStore tools - write_key", () => {
  it("fetches old value before writing", async () => {
    const mockClient = {
      configured: true,
      universeId: "123",
      readKey: vi.fn().mockResolvedValue({ value: "old-val" }),
      writeKey: vi.fn().mockResolvedValue({ version: "v2" }),
    } as unknown as OpenCloudClient;

    const mockApproval = vi.fn().mockResolvedValue("allow_once");
    const tools = createDataStoreTools(mockClient, mockApproval);
    const writeTool = tools.find((t) => t.name === "roblox_datastore__write_key");

    const ctx = {
      conversationId: "c1",
      runId: "r1",
      operationId: "op1",
      studioSessionId: "s1",
      signal: new AbortController().signal,
      requestInteraction: async () => [],
    } as ToolExecutionContext;

    await writeTool!.execute({ store: "Scores", scope: "global", key: "player1", value: "100" }, ctx);

    expect(mockClient.readKey).toHaveBeenCalledWith("Scores", "global", "player1", ctx.signal);
    expect(mockClient.writeKey).toHaveBeenCalledWith("Scores", "global", "player1", "100", ctx.signal);
  });

  it("refuses to write if approval denied", async () => {
    const mockClient = {
      configured: true,
      universeId: "123",
      readKey: vi.fn().mockResolvedValue({ value: "old-val" }),
      writeKey: vi.fn().mockResolvedValue({ version: "v2" }),
    } as unknown as OpenCloudClient;

    const mockApproval = vi.fn().mockResolvedValue("deny");
    const tools = createDataStoreTools(mockClient, mockApproval);
    const writeTool = tools.find((t) => t.name === "roblox_datastore__write_key");

    const ctx = {
      conversationId: "c1",
      runId: "r1",
      operationId: "op1",
      studioSessionId: "s1",
      signal: new AbortController().signal,
      requestInteraction: async () => [],
    } as ToolExecutionContext;

    const result = await writeTool!.execute({ store: "Scores", scope: "global", key: "player1", value: "100" }, ctx);

    expect(mockClient.writeKey).not.toHaveBeenCalled();
    expect(result).toMatchObject({ denied: true });
  });
});
