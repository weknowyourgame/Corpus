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

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const buildFetcher = (handlers: {
  search?: (url: URL) => unknown;
  details?: (url: URL) => unknown;
  thumbs?: (url: URL) => unknown;
}): typeof fetch => async (input) => {
  const url = new URL(String(input));
  if (url.hostname === "apis.roblox.com" && url.pathname.startsWith("/toolbox-service/v1/marketplace/")) {
    return jsonResponse(handlers.search?.(url) ?? { data: [], nextPageCursor: null, totalResults: 0 });
  }
  if (url.hostname === "apis.roblox.com" && url.pathname.startsWith("/toolbox-service/v1/items/details")) {
    return jsonResponse(handlers.details?.(url) ?? { data: [] });
  }
  if (url.hostname === "thumbnails.roblox.com") {
    return jsonResponse(handlers.thumbs?.(url) ?? { data: [] });
  }
  return new Response("not handled", { status: 500 });
};

describe("ToolboxService", () => {
  it("expands a Minecraft query, dedupes ids across expansions, and fetches details + thumbnails", async () => {
    const fetcher = buildFetcher({
      search: (url) => {
        const keyword = url.searchParams.get("keyword") ?? "";
        const cursor = url.searchParams.get("cursor");
        if (cursor) {
          return { data: [{ id: 200 }], nextPageCursor: null, totalResults: 11 };
        }
        if (keyword === "minecraft") {
          return { data: [{ id: 7 }, { id: 8 }, { id: 9 }], nextPageCursor: "page-2", totalResults: 11 };
        }
        return { data: [{ id: 9 }, { id: 10 }], nextPageCursor: null, totalResults: 2 };
      },
      details: (url) => {
        const ids = (url.searchParams.get("assetIds") ?? "").split(",").map(Number);
        return {
          data: ids.map((id) => ({
            asset: { id, name: `Asset ${id}`, hasScripts: id === 8, modelTechnicalDetails: { instanceCounts: { script: id === 8 ? 3 : 0 } } },
            creator: { name: id === 7 ? "Verified Co" : "Indie Dev", isVerifiedCreator: id === 7 },
            voting: { upVotes: id * 10, downVotes: 1 },
          })),
        };
      },
      thumbs: (url) => {
        const ids = (url.searchParams.get("assetIds") ?? "").split(",").map(Number);
        return { data: ids.map((id) => ({ targetId: id, state: "Completed", imageUrl: `https://thumb/${id}.png` })) };
      },
    });
    const service = new ToolboxService(fetcher);
    const result = await service.search({ query: "minecraft", limit: 8 }, new AbortController().signal) as {
      count: number;
      nextPageCursor: string;
      expandedQueries: string[];
      totalResults: number;
      pageSize: number;
      results: Array<{ id: number; thumbnailUrl: string; hasScripts: boolean; verifiedCreator: boolean }>;
      selectionQuestion: { options: Array<{ label: string; description: string }> };
    };

    expect(result.expandedQueries.length).toBeGreaterThan(1);
    expect(result.nextPageCursor).toBe("page-2");
    expect(result.totalResults).toBe(11);
    expect(result.pageSize).toBe(8);
    const ids = result.results.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.results[0]).toMatchObject({ thumbnailUrl: expect.stringContaining("https://thumb/") });
    const scriptedOption = result.selectionQuestion.options.find((option) => option.description.includes("contains scripts"));
    expect(scriptedOption).toBeDefined();
  });

  it("forwards the cursor for explicit pagination requests and omits expanded queries on page two", async () => {
    let searchCalls = 0;
    const fetcher = buildFetcher({
      search: (url) => {
        searchCalls += 1;
        if (url.searchParams.get("cursor") === "page-2") {
          return { data: [{ id: 100 }, { id: 101 }], nextPageCursor: "page-3", totalResults: 50 };
        }
        return { data: [], nextPageCursor: null };
      },
      details: (url) => ({
        data: (url.searchParams.get("assetIds") ?? "").split(",").filter(Boolean).map((id) => ({
          asset: { id: Number(id), name: `Asset ${id}` },
          creator: { name: "Page Two", isVerifiedCreator: false },
          voting: { upVotes: 5, downVotes: 0 },
        })),
      }),
      thumbs: () => ({ data: [] }),
    });
    const service = new ToolboxService(fetcher);
    const result = await service.search({ query: "tree", cursor: "page-2", limit: 5 }, new AbortController().signal) as {
      results: Array<{ id: number; thumbnailUrl: string | null }>;
      nextPageCursor: string;
    };
    expect(result.results.map((item) => item.id)).toEqual([100, 101]);
    expect(result.results.every((item) => item.thumbnailUrl === null)).toBe(true);
    expect(result.nextPageCursor).toBe("page-3");
    expect(searchCalls).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty result set when the upstream search fails on later pages", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "apis.roblox.com" && url.pathname.startsWith("/toolbox-service/v1/marketplace/")) {
        return new Response("upstream down", { status: 503 });
      }
      return new Response(JSON.stringify({ data: [] }));
    };
    const service = new ToolboxService(fetcher);
    await expect(service.search({ query: "anything" }, new AbortController().signal)).rejects.toThrow(/Creator Store search failed/);
  });

  it("renders results without thumbnails when the thumbnail endpoint is unavailable", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "thumbnails.roblox.com") return new Response("nope", { status: 503 });
      if (url.pathname.startsWith("/toolbox-service/v1/marketplace/")) {
        return jsonResponse({ data: [{ id: 1 }], nextPageCursor: null, totalResults: 1 });
      }
      if (url.pathname.startsWith("/toolbox-service/v1/items/details")) {
        return jsonResponse({ data: [{ asset: { id: 1, name: "No Thumb" }, creator: { name: "Anon" }, voting: { upVotes: 0, downVotes: 0 } }] });
      }
      return new Response("", { status: 500 });
    };
    const service = new ToolboxService(fetcher);
    const result = await service.search({ query: "thumbless" }, new AbortController().signal) as {
      results: Array<{ thumbnailUrl: string | null }>;
    };
    expect(result.results[0].thumbnailUrl).toBeNull();
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

  it("denies an asset insertion and never calls /asset/insert", async () => {
    const calls: Array<{ path: string }> = [];
    const relay = async (_session: string, path: string): Promise<JsonValue> => {
      calls.push({ path });
      return path === "/asset/inspect" ? { scriptCount: 1, riskyDescendantCount: 0 } : { inserted: true };
    };
    const tools = new RobloxStudioMcpGateway(relay);
    let turn = 0;
    const runtime = new AgentRuntime(new MemoryConversationStore(), () => ({
      generate: async () => {
        turn += 1;
        return turn === 1
          ? { text: "", toolCalls: [{ id: "asset2", name: "mcp__roblox_studio__insert_asset", input: { assetId: 12, parent: "game.Workspace" } }] }
          : { text: "Denied.", toolCalls: [] };
      },
    }), tools);
    const conversation = await runtime.createConversation("DENY1234");
    const run = await runtime.startRun(conversation.id, { message: "Insert risky", provider: "anthropic", model: "test" });
    const pending = await waitFor(async () => (await runtime.getConversation(conversation.id))?.events.find((event) => event.type === "approval_pending"));
    if (pending.type !== "approval_pending") throw new Error("Missing approval");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "deny");
    await waitFor(async () => (await runtime.getConversation(conversation.id))?.runs[0].status === "completed" ? true : undefined);
    expect(calls.map((call) => call.path)).toEqual(["/asset/inspect"]);
  });

  it("lists namespaced Studio MCP tools rather than browser executors", () => {
    const gateway = new RobloxStudioMcpGateway(async () => ({ ok: true }));
    const names = gateway.list().map((tool) => tool.name);
    expect(names).toContain("mcp__roblox_studio__create_instance");
    expect(names).toContain("mcp__roblox_studio__insert_asset");
    expect(names).not.toContain("roblox_create");
  });
});
