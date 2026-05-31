// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.ts";
import { MemoryConversationStore } from "./store.ts";
import { findMatchingPlanStep, createSubmitPlanTool, SUBMIT_PLAN_TOOL_NAME } from "./plan.ts";
import type {
  AgentTool,
  AgentToolRegistry,
  ApprovedPlan,
  ModelDriverFactory,
} from "./types.ts";

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out");
};

const createInstanceTool = (executions: Record<string, unknown>[]): AgentTool => ({
  name: "mcp__roblox_studio__create_instance",
  description: "create",
  transport: "studio_mcp",
  risk: "low_mutation",
  concurrency: "exclusive_mutation",
  inputSchema: {},
  scope: (input) => `${String(input.parent)}/${String(input.name)}:${String(input.className)}`,
  execute: async (input) => {
    executions.push(input);
    return { created: String(input.name) };
  },
});

const registry = (tools: AgentTool[]): AgentToolRegistry => ({
  list: () => tools,
  get: (name) => tools.find((tool) => tool.name === name),
});

describe("findMatchingPlanStep", () => {
  const plan: ApprovedPlan = {
    planId: "p1",
    summary: "x",
    approvedAt: "2025-01-01",
    consumedStepIndices: [0],
    steps: [
      { toolName: "mcp__roblox_studio__create_instance", scope: "game.Workspace/Plot:Folder", summary: "s1" },
      { toolName: "mcp__roblox_studio__create_instance", scope: "game.Workspace/Plot:Folder", summary: "s2" },
      { toolName: "mcp__roblox_studio__create_instance", scope: "game.Workspace/Other:Folder", summary: "s3" },
    ],
  };

  it("skips consumed step indices", () => {
    const idx = findMatchingPlanStep(plan, "mcp__roblox_studio__create_instance", "game.Workspace/Plot:Folder");
    expect(idx).toBe(1);
  });

  it("returns undefined when no step matches the scope", () => {
    expect(findMatchingPlanStep(plan, "mcp__roblox_studio__create_instance", "game.Workspace/Unknown:Folder")).toBeUndefined();
  });

  it("returns undefined when plan is missing", () => {
    expect(findMatchingPlanStep(undefined, "any", "any")).toBeUndefined();
  });
});

describe("submit_plan tool", () => {
  it("captures the plan via the runtime context callback", async () => {
    const tool = createSubmitPlanTool();
    let captured: { planId: string; summary: string } | undefined;
    const result = await tool.execute(
      {
        summary: "Build a plot",
        steps: [
          { toolName: "mcp__roblox_studio__create_instance", scope: "game.Workspace/Plot:Folder", summary: "Create Plot folder" },
        ],
      },
      {
        conversationId: "c",
        runId: "r",
        operationId: "o",
        studioSessionId: "s",
        signal: new AbortController().signal,
        requestInteraction: async () => [],
        setProposedPlan: async (plan) => { captured = { planId: plan.planId, summary: plan.summary }; },
      },
    );
    expect((result as Record<string, unknown>).accepted).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.summary).toBe("Build a plot");
  });

  it("refuses gracefully when the runtime exposes no setProposedPlan", async () => {
    const tool = createSubmitPlanTool();
    const result = await tool.execute(
      { summary: "x", steps: [{ toolName: "a", scope: "b", summary: "c" }] },
      {
        conversationId: "c",
        runId: "r",
        operationId: "o",
        studioSessionId: "s",
        signal: new AbortController().signal,
        requestInteraction: async () => [],
      },
    );
    expect((result as Record<string, unknown>).accepted).toBe(false);
  });
});

describe("approved-plan execution", () => {
  it("authorizes a mutation that matches an approved plan step without prompting", async () => {
    const executions: Record<string, unknown>[] = [];
    const create = createInstanceTool(executions);
    const submitPlan = createSubmitPlanTool();
    const tools = registry([create, submitPlan]);

    // The mock driver tracks calls per run id. The plan run gets one turn
    // that submits a plan, then a second turn that returns text-only to
    // finish the run. The execute run gets one turn with the matching
    // create_instance tool call, then a final text-only turn.
    let planTurn = 0;
    let executeTurn = 0;
    let runStartedCount = 0;
    const factory: ModelDriverFactory = () => {
      runStartedCount += 1;
      const isPlanRun = runStartedCount === 1;
      return {
        generate: async () => {
          if (isPlanRun) {
            planTurn += 1;
            if (planTurn === 1) {
              return {
                text: "Plan ready.",
                toolCalls: [
                  {
                    id: "submit-1",
                    name: SUBMIT_PLAN_TOOL_NAME,
                    input: {
                      summary: "Build the plot",
                      steps: [
                        {
                          toolName: "mcp__roblox_studio__create_instance",
                          scope: "game.Workspace/Plot:Folder",
                          summary: "Create the Plot folder",
                        },
                      ],
                    },
                  },
                ],
              };
            }
            return { text: "Awaiting your approval.", toolCalls: [] };
          }
          executeTurn += 1;
          if (executeTurn === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "do-1",
                  name: "mcp__roblox_studio__create_instance",
                  input: { parent: "game.Workspace", name: "Plot", className: "Folder" },
                },
              ],
            };
          }
          return { text: "All done.", toolCalls: [] };
        },
      };
    };

    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, tools);
    const conversation = await runtime.createConversation("ABCDEF12");

    // Plan run
    await runtime.startRun(conversation.id, { message: "Plan it", tier: "pro", mode: "plan" });
    // Wait for the plan-mode run to complete and the plan steps event to land
    const proposed = await waitFor(async () => {
      const events = (await runtime.getConversation(conversation.id))?.events ?? [];
      return events.find((event) => event.type === "plan_steps_proposed");
    });
    if (proposed.type !== "plan_steps_proposed") throw new Error("Missing plan_steps_proposed");

    // Approve the plan
    const ok = await runtime.approvePlan(conversation.id, proposed.planId);
    expect(ok).toBe(true);

    // Execute run — should NOT prompt for approval
    await runtime.startRun(conversation.id, { message: "Execute", tier: "pro" });
    await waitFor(async () => {
      const conv = await runtime.getConversation(conversation.id);
      return conv?.runs.at(-1)?.status === "completed" ? true : undefined;
    });

    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ parent: "game.Workspace", name: "Plot", className: "Folder" });
    const conv = await runtime.getConversation(conversation.id);
    // Plan was fully consumed; approvedPlan should be cleared.
    expect(conv?.approvedPlan).toBeUndefined();
    expect(conv?.events.some((event) => event.type === "approval_pending")).toBe(false);
  });

  it("still prompts when the model deviates from the approved scope", async () => {
    const executions: Record<string, unknown>[] = [];
    const create = createInstanceTool(executions);
    const tools = registry([create]);

    let turn = 0;
    const factory: ModelDriverFactory = () => ({
      generate: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [
              {
                id: "do-1",
                name: "mcp__roblox_studio__create_instance",
                input: { parent: "game.Workspace", name: "DifferentName", className: "Folder" },
              },
            ],
          };
        }
        return { text: "Done.", toolCalls: [] };
      },
    });

    const runtime = new AgentRuntime(new MemoryConversationStore(), factory, tools);
    const conversation = await runtime.createConversation("ABCDEF12");
    // Seed an approved plan that only authorizes name=Plot, not DifferentName.
    const seeded = await runtime.getConversation(conversation.id);
    if (!seeded) throw new Error("missing");
    seeded.approvedPlan = {
      planId: "p1",
      summary: "x",
      approvedAt: new Date().toISOString(),
      consumedStepIndices: [],
      steps: [
        {
          toolName: "mcp__roblox_studio__create_instance",
          scope: "game.Workspace/Plot:Folder",
          summary: "Create Plot",
        },
      ],
    };
    await (runtime as unknown as { store: { save: (c: unknown) => Promise<void> } }).store.save(seeded);

    const run = await runtime.startRun(conversation.id, { message: "go", tier: "pro" });
    const pending = await waitFor(async () => {
      const conv = await runtime.getConversation(conversation.id);
      return conv?.events.find((event) => event.type === "approval_pending");
    });
    if (pending.type !== "approval_pending") throw new Error("Missing approval_pending");
    await runtime.answerApproval(conversation.id, run.id, pending.approvalId, "deny");
    await waitFor(async () => {
      const conv = await runtime.getConversation(conversation.id);
      return conv?.runs[0].status === "completed" ? true : undefined;
    });
    expect(executions).toHaveLength(0);
  });
});
