// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { DevelopmentConversationStore } from "./store.ts";
import type { AgentTool, AgentToolRegistry, ModelDriver } from "./types.ts";

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out");
};

const readTool: AgentTool = {
  name: "read",
  description: "read",
  transport: "studio_mcp",
  risk: "read",
  concurrency: "parallel_read",
  inputSchema: {},
  scope: () => "any",
  execute: async () => ({ ok: true }),
};
const tools: AgentToolRegistry = {
  list: () => [readTool],
  get: (name) => name === readTool.name ? readTool : undefined,
};

const fileSize = async (path: string) => {
  const info = await stat(path).catch(() => null);
  return info?.size ?? 0;
};

const tempStoreDir = () => {
  const root = mkdtempSync(join(tmpdir(), "stud-durability-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

describe("DevelopmentConversationStore durability", () => {
  it("streams text deltas to the event log without rewriting the snapshot for each token", async () => {
    const { root, cleanup } = tempStoreDir();
    try {
      const store = new DevelopmentConversationStore(root);
      const conversation = await store.create("ABCDEF12");
      const snapshotPath = join(root, conversation.id, "snapshot.json");
      const eventLogPath = join(root, conversation.id, "events.jsonl");

      const initialSnapshotSize = await fileSize(snapshotPath);
      expect(initialSnapshotSize).toBeGreaterThan(0);

      const driver: ModelDriver = {
        generate: async (input) => {
          for (const t of ["one ", "two ", "three ", "four ", "five "]) {
            await input.onTextDelta(t);
          }
          return { text: "one two three four five ", toolCalls: [] };
        },
      };
      const runtime = new AgentRuntime(store, () => driver, tools);
      await waitFor(async () => {
        const conv = await store.get(conversation.id);
        return conv?.runs[0].status === "completed" ? true : undefined;
      });

      const finalSnapshotSize = await fileSize(snapshotPath);
      const log = await readFile(eventLogPath, "utf8");
      const events = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const textDeltas = events.filter((event) => event.type === "text_delta");
      // The event log captured every streamed token.
      expect(textDeltas).toHaveLength(5);

      // The snapshot does not balloon with text content — it stays roughly
      // the size of conversation metadata (well under 8 kB for an empty
      // conversation, even with a few audit/messages entries).
      expect(finalSnapshotSize).toBeLessThan(8 * 1024);

      const reloaded = await store.get(conversation.id);
      // All five text deltas survive a reload.
      expect(reloaded?.events.filter((event) => event.type === "text_delta")).toHaveLength(5);
      // run_started + run_completed + 5 text_deltas = 7 total events.
      expect(reloaded?.events).toHaveLength(7);
    } finally {
      await cleanup();
    }
  });

  it("recovers crashed runs and clears their pending state on restart", async () => {
    const { root, cleanup } = tempStoreDir();
    try {
      const store = new DevelopmentConversationStore(root);
      const conversation = await store.create("ABCDEF12");
      // Simulate a process that died while a run was active with a pending
      // approval — write the snapshot ourselves so we don't need a real
      // runtime to crash mid-flight.
      const now = new Date().toISOString();
      conversation.runs.push({
        id: "run-1",
        status: "running",
        mode: "execute",
        tier: "pro",
        startedAt: now,
        iterations: 1,
      });
      conversation.pendingApprovals = [{
        approvalId: "appr-1",
        runId: "run-1",
        toolCallId: "tc-1",
        toolName: "mcp__roblox_studio__create_instance",
        input: { parent: "game.Workspace", name: "Plot" },
        summary: "create plot",
        scope: "game.Workspace/Plot",
        risk: "low_mutation",
        createdAt: now,
      }];
      await store.save(conversation);

      const recovered = await store.recoverFromCrash();
      expect(recovered).toContain(conversation.id);

      const reloaded = await store.get(conversation.id);
      expect(reloaded?.runs[0].status).toBe("cancelled");
      expect(reloaded?.runs[0].error).toMatch(/server restart/i);
      expect(reloaded?.pendingApprovals).toEqual([]);
      // The cleanup also emitted an approval_resolved event so any
      // reconnecting UI sees the approval as no longer pending.
      const resolved = reloaded?.events.find((event) => event.type === "approval_resolved");
      expect(resolved?.type).toBe("approval_resolved");
    } finally {
      await cleanup();
    }
  });

  it("survives a malformed event log line without losing other events", async () => {
    const { root, cleanup } = tempStoreDir();
    try {
      const store = new DevelopmentConversationStore(root);
      const conversation = await store.create("ABCDEF12");
      const driver: ModelDriver = {
        generate: async (input) => {
          await input.onTextDelta("hello");
          return { text: "hello", toolCalls: [] };
        },
      };
      const runtime = new AgentRuntime(store, () => driver, tools);
      await waitFor(async () => {
        const conv = await store.get(conversation.id);
        return conv?.runs[0].status === "completed" ? true : undefined;
      });

      // Corrupt the log: append a garbage line.
      const logPath = join(root, conversation.id, "events.jsonl");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(logPath, "this is not json\n", "utf8");

      const reloaded = await store.get(conversation.id);
      // We still get the good events back.
      expect(reloaded?.events.find((event) => event.type === "text_delta")).toBeDefined();
      expect(reloaded?.events.find((event) => event.type === "run_completed")).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});
