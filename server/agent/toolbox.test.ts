// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import { ToolboxService } from "./toolbox.ts";
import { RobloxStudioMcpGateway } from "./tools.ts";
import type { JsonValue } from "./types.ts";

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for event");
};

describe("ToolboxService", () => {
  it("expands a world query, deduplicates results, preserves pagination, and adds thumbnails", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("thumbnails.roblox.com")) {
        return new Response(JSON.stringify({ data: [{ targetId: 7, imageUrl: "https://image/7.png", state: "Completed" }] }));
      }
      return new Response(JSON.stringify({
        data: [{ id: 7, name: "Block Starter", creatorName: "Builder", favoriteCount: 100 }],
        nextPageCursor: url.includes("Keyword=minecraft") ? "page-2" : undefined,
      }));
    };
    const service = new ToolboxService(fetcher);
    const result = await service.search({ query: "minecraft", limit: 8 }, new AbortController().signal) as {
      count: number;
      nextPageCursor: string;
      expandedQueries: string[];
      results: Array<{ id: number; thumbnailUrl: string }>;
    };

    expect(result.expandedQueries.length).toBeGreaterThan(1);
    expect(result.count).toBe(1);
    expect(result.nextPageCursor).toBe("page-2");
    expect(result.results[0]).toMatchObject({ id: 7, thumbnailUrl: "https://image/7.png" });
  });
});

describe("RobloxStudioMcpGateway asset insertion", () => {
  it("previews a selected asset and passes script stripping only after approval", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
    const relay = async (
      _session: string,
      path: string,
      body: Record<string, unknown> | undefined,
    ): Promise<JsonValue> => {
      calls.push({ path, body });
      return path === "/asset/inspect" ? { scriptCount: 2, riskyDescendantCount: 0 } : { inserted: true };
    };
    const tools = new RobloxStudioMcpGateway(relay);
    let turn = 0;
    const runtime = new AgentRuntime(new MemoryConversationStore(), () => ({
      generate: async () => {
        turn += 1;
        return turn === 1
          ? { text: "", toolCalls: [{ id: "asset", name: "mcp__roblox_studio__insert_asset", input: { assetId: 7, parent: "game.Workspace" } }] }
          : { text: "Inserted safely.", toolCalls: [] };
      },
    }), tools);
    const conversation = await runtime.createConversation("ABCDEF12");
    const run = await runtime.startRun(conversation.id, { message: "Insert", provider: "anthropic", model: "test" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events
      .find((event) => event.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("Missing approval");

    expect(pending.allowStripScripts).toBe(true);
    expect(calls).toEqual([{ path: "/asset/inspect", body: { assetId: 7 } }]);
    expect(await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "allow_scope")).toBe(false);
    expect(calls).toHaveLength(1);
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "insert_without_scripts");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(calls[1]).toMatchObject({
      path: "/asset/insert",
      body: { assetId: 7, parent: "game.Workspace", stripScripts: true },
    });
  });

  it("lists namespaced Studio MCP tools rather than browser executors", () => {
    const gateway = new RobloxStudioMcpGateway(async () => ({ ok: true }));
    const names = gateway.list().map((tool) => tool.name);
    expect(names).toContain("mcp__roblox_studio__create_instance");
    expect(names).toContain("mcp__roblox_studio__insert_asset");
    expect(names).not.toContain("roblox_create");
  });
});
