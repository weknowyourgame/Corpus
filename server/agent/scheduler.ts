import type { AgentToolCall, AgentToolRegistry, JsonValue } from "./types.ts";

export type ScheduledOutcome = {
  toolCallId: string;
  toolName: string;
  output: JsonValue;
};

export type ToolExecutor = (call: AgentToolCall) => Promise<JsonValue>;

/**
 * Splits a model turn's tool calls into ordered batches preserving model
 * intent: consecutive `parallel_read` calls run together; a single
 * `exclusive_mutation` call runs alone. Mutations never overlap with reads
 * or with each other, because a read can race a mutation's preview probe.
 *
 * Unknown tools (registry returns undefined) are scheduled as exclusive so
 * we don't accidentally run them next to a real read.
 */
export function planBatches(calls: AgentToolCall[], registry: AgentToolRegistry): AgentToolCall[][] {
  const batches: AgentToolCall[][] = [];
  let current: AgentToolCall[] | null = null;

  for (const call of calls) {
    const tool = registry.get(call.name);
    const parallel = tool?.concurrency === "parallel_read";
    if (parallel) {
      if (!current) {
        current = [call];
        batches.push(current);
      } else {
        current.push(call);
      }
      continue;
    }
    current = null;
    batches.push([call]);
  }
  return batches;
}

/**
 * Executes the planned batches preserving the original call order in the
 * returned outcomes. Cancellation aborts the remaining batches as soon as
 * possible; partial outcomes from already-running parallel calls are
 * collected and returned with a structured cancellation marker for the
 * unscheduled remainder, so the runtime can record what happened in the
 * conversation log.
 */
export async function executeBatches(
  calls: AgentToolCall[],
  registry: AgentToolRegistry,
  executor: ToolExecutor,
  signal: AbortSignal,
): Promise<ScheduledOutcome[]> {
  const batches = planBatches(calls, registry);
  const outcomes = new Map<string, ScheduledOutcome>();

  for (const batch of batches) {
    if (signal.aborted) {
      for (const call of batch) {
        outcomes.set(call.id, {
          toolCallId: call.id,
          toolName: call.name,
          output: { cancelled: true, reason: "Cancelled by user" },
        });
      }
      continue;
    }
    const results = await Promise.all(
      batch.map(async (call): Promise<ScheduledOutcome> => {
        const output = await executor(call);
        return { toolCallId: call.id, toolName: call.name, output };
      }),
    );
    for (const result of results) outcomes.set(result.toolCallId, result);
  }

  return calls.map((call) =>
    outcomes.get(call.id) ?? {
      toolCallId: call.id,
      toolName: call.name,
      output: { cancelled: true, reason: "Cancelled by user" },
    },
  );
}
