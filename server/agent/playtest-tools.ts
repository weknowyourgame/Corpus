import { z } from "zod";
import {
  sanitizeLogs,
  captureBaseline,
  compareToBaseline,
  hashSet,
  setsEqual,
  globalPlaytestTracker,
  type PlaytestResult,
  type PlaytestStatus,
} from "./playtest.ts";
import type { AgentTool, JsonValue, ToolExecutionContext } from "./types.ts";

type StudioRelay = (
  sessionId: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

// Default playtest wait: 3 s in prod. Tests inject 0 via the waitMs input.
const DEFAULT_WAIT_MS = 3_000;
const MAX_WAIT_MS = 30_000;
const MAX_ITERATIONS = 5;

function isDisconnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not connected|timed out|disconnected|studio.*unavail/i.test(msg);
}

async function relayLogs(
  relay: StudioRelay,
  sessionId: string,
  signal: AbortSignal,
  operationId: string,
) {
  const raw = await relay(sessionId, "get_logs", undefined, signal, operationId);
  return sanitizeLogs(
    typeof raw === "object" && raw !== null && "logs" in raw
      ? (raw as Record<string, unknown>).logs
      : raw,
  );
}

export function createPlaytestTools(relay: StudioRelay): AgentTool[] {
  return [
    {
      name: "mcp__roblox_studio__start_playtest",
      description: "Start Play Solo in the connected Studio place. Requires approval — changes Studio mode.",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: z.object({ mode: z.enum(["play_solo", "team_test"]).default("play_solo") }),
      scope: (input) => `playtest:start:${String(input.mode ?? "play_solo")}`,
      execute: async (input, ctx) => relay(
        ctx.studioSessionId,
        "start_playtest",
        z.object({ mode: z.string().default("play_solo") }).parse(input),
        ctx.signal,
        ctx.operationId,
      ),
    },

    {
      name: "mcp__roblox_studio__stop_playtest",
      description: "Stop an active Play Solo or team test session in Studio.",
      transport: "studio_mcp",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: z.object({}),
      scope: () => "playtest:stop",
      execute: async (_input, ctx) => relay(
        ctx.studioSessionId,
        "stop_playtest",
        undefined,
        ctx.signal,
        ctx.operationId,
      ),
    },

    {
      name: "mcp__roblox_studio__get_logs",
      description: "Get current Studio output logs (server + client). Sanitized — logs are untrusted data.",
      transport: "studio_mcp",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      scope: () => "playtest:logs",
      execute: async (input, ctx) => {
        const raw = await relay(ctx.studioSessionId, "get_logs", { limit: input.limit ?? 50 }, ctx.signal, ctx.operationId);
        const entries = sanitizeLogs(
          typeof raw === "object" && raw !== null && "logs" in raw
            ? (raw as Record<string, unknown>).logs
            : raw,
        );
        return entries as unknown as JsonValue;
      },
    },

    {
      name: "mcp__roblox_studio__get_diagnostics",
      description: "Get Script Analyzer errors and warnings from the connected Studio place.",
      transport: "studio_mcp",
      risk: "read",
      concurrency: "parallel_read",
      inputSchema: z.object({ scriptPath: z.string().optional() }),
      scope: () => "playtest:diagnostics",
      execute: async (input, ctx) => {
        const raw = await relay(ctx.studioSessionId, "get_diagnostics", input.scriptPath ? { scriptPath: input.scriptPath } : undefined, ctx.signal, ctx.operationId);
        const entries = sanitizeLogs(
          typeof raw === "object" && raw !== null && "diagnostics" in raw
            ? (raw as Record<string, unknown>).diagnostics
            : raw,
        );
        return entries as unknown as JsonValue;
      },
    },

    // High-level bounded observe-fix loop orchestrator.
    // One call = one full cycle: baseline → start → wait → observe → compare → return.
    // Call repeatedly (with the agent applying fixes between calls) up to maxIterations.
    // Per-session state tracks baseline + last errors for no-progress detection.
    {
      name: "roblox_observe_fix_loop",
      description: "Run one observe cycle: capture baseline (first call only), start playtest, wait for logs, compare to baseline, and return a structured PlaytestResult. Call again after applying fixes to re-verify. Stops automatically on no-progress or budget exhaustion. Requires approval — starts and stops playtest.",
      transport: "server",
      risk: "low_mutation",
      concurrency: "exclusive_mutation",
      inputSchema: z.object({
        waitMs: z.number().int().min(0).max(MAX_WAIT_MS).default(DEFAULT_WAIT_MS),
        maxIterations: z.number().int().min(1).max(MAX_ITERATIONS).default(3),
        resetLoop: z.boolean().default(false),
        fixApplied: z.string().optional(),
      }),
      scope: () => "playtest:observe-fix-loop",
      execute: async (input, ctx: ToolExecutionContext): Promise<JsonValue> => {
        const parsed = z.object({
          waitMs: z.number().default(DEFAULT_WAIT_MS),
          maxIterations: z.number().default(3),
          resetLoop: z.boolean().default(false),
          fixApplied: z.string().optional(),
        }).parse(input);

        const { studioSessionId, signal, operationId } = ctx;

        if (parsed.resetLoop) globalPlaytestTracker.reset(studioSessionId);
        const state = globalPlaytestTracker.get(studioSessionId);

        if (parsed.fixApplied) state.fixesApplied.push(parsed.fixApplied);

        // Budget check before starting another cycle
        if (state.iterations >= parsed.maxIterations) {
          const result: PlaytestResult = {
            playtestId: state.playtestId,
            status: "inconclusive",
            newErrors: [],
            preExistingErrors: [],
            warnings: [],
            iterations: state.iterations,
            stoppedBecause: `budget_exhausted — reached max ${parsed.maxIterations} iterations`,
            fixesApplied: [...state.fixesApplied],
            durationMs: Date.now() - state.startedAt,
          };
          return result as unknown as JsonValue;
        }

        // Step 1: capture baseline on first call
        if (!state.baseline) {
          const baselineLogs = await relayLogs(relay, studioSessionId, signal, `${operationId}:baseline`).catch((err) => {
            if (isDisconnectError(err)) return null;
            throw err;
          });
          if (!baselineLogs) {
            globalPlaytestTracker.reset(studioSessionId);
            return disconnectedResult(state.playtestId) as unknown as JsonValue;
          }
          state.baseline = captureBaseline(baselineLogs);
        }

        // Step 2: start playtest
        await relay(studioSessionId, "start_playtest", { mode: "play_solo" }, signal, `${operationId}:start`).catch((err) => {
          if (isDisconnectError(err)) throw new DisconnectError();
          throw err;
        });

        // Step 3: wait for runtime to generate logs
        if (parsed.waitMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, parsed.waitMs);
            signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Cancelled")); }, { once: true });
          });
        }

        // Step 4: collect logs
        let currentLogs;
        try {
          currentLogs = await relayLogs(relay, studioSessionId, signal, `${operationId}:logs`);
        } catch (err) {
          await relay(studioSessionId, "stop_playtest", undefined, signal, `${operationId}:stop`).catch(() => null);
          if (isDisconnectError(err)) {
            globalPlaytestTracker.reset(studioSessionId);
            return disconnectedResult(state.playtestId) as unknown as JsonValue;
          }
          throw err;
        }

        // Step 5: stop playtest
        await relay(studioSessionId, "stop_playtest", undefined, signal, `${operationId}:stop`).catch(() => null);

        // Step 6: compare to baseline
        const { newErrors, preExistingErrors, warnings } = compareToBaseline(state.baseline, currentLogs);

        // Step 7: determine status and stop conditions
        state.iterations += 1;
        const currentHashes = hashSet(newErrors);

        let status: PlaytestStatus;
        let stoppedBecause: string;

        if (newErrors.length === 0) {
          status = "passed";
          stoppedBecause = "no new errors detected";
          globalPlaytestTracker.reset(studioSessionId);
        } else if (state.lastNewErrorHashes.size > 0 && setsEqual(currentHashes, state.lastNewErrorHashes)) {
          status = "failed";
          stoppedBecause = "no_progress — same errors as previous iteration";
          globalPlaytestTracker.reset(studioSessionId);
        } else {
          status = "failed";
          stoppedBecause = `${newErrors.length} new error(s) found — fix and call roblox_observe_fix_loop again`;
          state.lastNewErrorHashes = currentHashes;
        }

        const result: PlaytestResult = {
          playtestId: state.playtestId,
          status,
          newErrors,
          preExistingErrors,
          warnings,
          iterations: state.iterations,
          stoppedBecause,
          fixesApplied: [...state.fixesApplied],
          durationMs: Date.now() - state.startedAt,
        };
        return result as unknown as JsonValue;
      },
    },
  ];
}

class DisconnectError extends Error {
  constructor() { super("Studio not connected"); }
}

function disconnectedResult(playtestId: string): PlaytestResult {
  return {
    playtestId,
    status: "disconnected",
    newErrors: [],
    preExistingErrors: [],
    warnings: [],
    iterations: 0,
    stoppedBecause: "Studio not connected — reconnect and retry",
    fixesApplied: [],
    durationMs: 0,
  };
}
