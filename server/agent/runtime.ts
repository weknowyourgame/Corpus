import { randomUUID } from "node:crypto";
import { PermissionPolicy } from "./policy.ts";
import type {
  AgentAnswer,
  AgentEvent,
  AgentEventData,
  AgentQuestion,
  AgentRun,
  AgentTool,
  AgentToolRegistry,
  ApprovalDecision,
  AuditEvent,
  Conversation,
  ConversationStore,
  JsonValue,
  ModelDriverFactory,
  StartRunInput,
  ToolExecutionContext,
  ToolRisk,
} from "./types.ts";

const now = () => new Date().toISOString();

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type ActiveRun = {
  controller: AbortController;
  interactions: Map<string, Pending<AgentAnswer[]>>;
  approvals: Map<string, Pending<ApprovalDecision> & { risk: ToolRisk; allowStripScripts: boolean }>;
};

type Listener = (event: AgentEvent) => void;

export class AgentRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly store: ConversationStore,
    private readonly drivers: ModelDriverFactory,
    private readonly tools: AgentToolRegistry,
    private readonly maxIterations = 10,
    private readonly policy = new PermissionPolicy(),
  ) {}

  createConversation(studioSessionId: string, accessTokenHash?: string) {
    return this.store.create(studioSessionId, accessTokenHash);
  }

  getConversation(id: string) {
    return this.store.get(id);
  }

  async startRun(conversationId: string, input: StartRunInput) {
    const conversation = await this.requiredConversation(conversationId);
    if (conversation.runs.some((run) => run.status === "running")) {
      throw new Error("A run is already active for this conversation");
    }

    const run: AgentRun = {
      id: randomUUID(),
      status: "running",
      mode: input.mode ?? "execute",
      provider: input.provider,
      model: input.model,
      startedAt: now(),
      iterations: 0,
    };
    conversation.messages.push({ role: "user", content: input.message });
    conversation.runs.push(run);
    conversation.auditEvents.push(this.audit(run.id, "prompt", "user", `Prompt received in ${run.mode} mode.`, {
      mode: run.mode,
      message: input.message,
    }));
    const active: ActiveRun = {
      controller: new AbortController(),
      interactions: new Map(),
      approvals: new Map(),
    };
    this.active.set(run.id, active);
    await this.emit(conversation, run.id, {
      type: "run_started",
      provider: input.provider,
      model: input.model,
      mode: run.mode,
    });

    void this.execute(conversation.id, run.id, input).finally(() => {
      this.active.delete(run.id);
    });

    return run;
  }

  async cancelRun(conversationId: string, runId: string) {
    const conversation = await this.requiredConversation(conversationId);
    const run = conversation.runs.find((item) => item.id === runId);
    if (!run || run.status !== "running") return false;
    const active = this.active.get(runId);
    active?.controller.abort("Cancelled by user");
    for (const pending of active?.interactions.values() ?? []) pending.reject(new Error("Cancelled by user"));
    for (const pending of active?.approvals.values() ?? []) pending.reject(new Error("Cancelled by user"));
    return true;
  }

  async answerInteraction(conversationId: string, runId: string, interactionId: string, answers: AgentAnswer[]) {
    const active = this.active.get(runId);
    const interaction = active?.interactions.get(interactionId);
    if (!interaction) return false;
    active?.interactions.delete(interactionId);
    await this.emitById(conversationId, runId, { type: "interaction_resolved", interactionId });
    interaction.resolve(answers);
    return true;
  }

  async answerApproval(conversationId: string, runId: string, approvalId: string, decision: ApprovalDecision) {
    const active = this.active.get(runId);
    const approval = active?.approvals.get(approvalId);
    if (!approval) return false;
    if (decision === "allow_scope" && approval.risk !== "low_mutation") return false;
    if (decision === "insert_without_scripts" && !approval.allowStripScripts) return false;
    const conversation = await this.requiredConversation(conversationId);
    conversation.auditEvents.push({
      ...this.audit(runId, "approval_decision", "user", `User selected ${decision}.`, { approvalId }),
      decision,
    });
    await this.store.save(conversation);
    active?.approvals.delete(approvalId);
    await this.emitById(conversationId, runId, { type: "approval_resolved", approvalId, decision });
    approval.resolve(decision);
    return true;
  }

  async subscribe(conversationId: string, after: number, listener: Listener) {
    const conversation = await this.requiredConversation(conversationId);
    for (const event of conversation.events.filter((item) => item.sequence > after)) listener(event);
    const set = this.listeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(conversationId);
    };
  }

  private async execute(conversationId: string, runId: string, input: StartRunInput) {
    const active = this.active.get(runId);
    if (!active) return;
    try {
      const driver = this.drivers({ provider: input.provider, model: input.model });
      let fullText = "";

      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        this.throwIfAborted(active.controller.signal);
        const conversation = await this.requiredConversation(conversationId);
        const run = this.requiredRun(conversation, runId);
        run.iterations = iteration;
        await this.store.save(conversation);

        const turn = await driver.generate({
          messages: conversation.messages,
          signal: active.controller.signal,
          onTextDelta: async (text) => {
            fullText += text;
            await this.emitById(conversationId, runId, { type: "text_delta", text });
          },
        });
        this.throwIfAborted(active.controller.signal);

        const next = await this.requiredConversation(conversationId);
        next.messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
        await this.store.save(next);
        if (!turn.toolCalls.length) {
          const finished = this.requiredRun(next, runId);
          finished.status = "completed";
          finished.completedAt = now();
          if (finished.mode === "plan") {
            next.auditEvents.push(this.audit(runId, "plan_proposed", "model", "Read-only plan proposed.", { text: fullText }));
            await this.emit(next, runId, { type: "plan_proposed", text: fullText });
          }
          await this.emit(next, runId, { type: "run_completed", text: fullText, iterations: iteration });
          return;
        }

        for (const call of turn.toolCalls) {
          this.throwIfAborted(active.controller.signal);
          await this.emitById(conversationId, runId, {
            type: "tool_call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          });
          const output = await this.handleToolCall(conversationId, runId, call.id, call.name, call.input, active);
          const withResult = await this.requiredConversation(conversationId);
          withResult.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, output });
          await this.emit(withResult, runId, { type: "tool_result", toolCallId: call.id, toolName: call.name, output });
        }
      }

      const conversation = await this.requiredConversation(conversationId);
      const run = this.requiredRun(conversation, runId);
      run.status = "error";
      run.error = `Reached maximum tool iterations (${this.maxIterations})`;
      run.completedAt = now();
      await this.emit(conversation, runId, { type: "run_error", error: run.error });
    } catch (error) {
      const conversation = await this.requiredConversation(conversationId);
      const run = this.requiredRun(conversation, runId);
      const cancelled = active.controller.signal.aborted;
      run.status = cancelled ? "cancelled" : "error";
      run.completedAt = now();
      if (cancelled) {
        await this.emit(conversation, runId, { type: "run_cancelled", reason: "Cancelled by user" });
        return;
      }
      run.error = error instanceof Error ? error.message : String(error);
      await this.emit(conversation, runId, { type: "run_error", error: run.error });
    }
  }

  private async handleToolCall(
    conversationId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    active: ActiveRun,
  ) {
    const tool = this.tools.get(toolName);
    if (!tool) return { denied: true, reason: `Unknown tool: ${toolName}` };
    const conversation = await this.requiredConversation(conversationId);
    const run = this.requiredRun(conversation, runId);
    const assessment = this.policy.assess(tool, input, conversation, run);
    conversation.auditEvents.push({
      ...this.audit(runId, "tool_requested", "model", assessment.summary, asJson(input)),
      toolCallId,
      toolName,
      risk: tool.risk,
    });
    conversation.auditEvents.push({
      ...this.audit(runId, "policy_decision", "policy", assessment.reason, { scope: assessment.scope }),
      toolCallId,
      toolName,
      risk: tool.risk,
      decision: assessment.decision,
    });
    await this.store.save(conversation);
    if (assessment.decision === "deny") {
      const output = { denied: true, reason: assessment.reason, scope: assessment.scope };
      conversation.auditEvents.push({
        ...this.audit(runId, "tool_outcome", "tool", `${tool.name} was denied by policy.`, output),
        toolCallId,
        toolName,
        risk: tool.risk,
      });
      await this.store.save(conversation);
      return output;
    }

    const context = this.toolContext(conversation, runId, toolCallId, active);
    let executionInput = input;
    if (assessment.decision === "ask") {
      const preview = tool.preview ? await tool.preview(input, context) : undefined;
      const approval = await this.requestApproval(
        conversationId,
        runId,
        toolCallId,
        tool,
        input,
        assessment.summary,
        assessment.scope,
        preview,
      );
      if (approval.decision === "deny") {
        const output = { denied: true, reason: "User denied this action.", scope: assessment.scope };
        const current = await this.requiredConversation(conversationId);
        current.auditEvents.push({
          ...this.audit(runId, "tool_outcome", "tool", `${tool.name} was denied by user.`, output),
          toolCallId,
          toolName,
          risk: tool.risk,
        });
        await this.store.save(current);
        return output;
      }
      if (approval.decision === "insert_without_scripts") executionInput = { ...input, stripScripts: true };
      if (approval.decision === "allow_scope") {
        const current = await this.requiredConversation(conversationId);
        current.approvedScopes.push({
          id: randomUUID(),
          toolName,
          scope: assessment.scope,
          approvedAt: now(),
          approvalId: approval.approvalId,
        });
        await this.store.save(current);
      }
    }

    const output = await tool.execute(executionInput, context);
    const current = await this.requiredConversation(conversationId);
    current.auditEvents.push({
      ...this.audit(runId, "tool_outcome", "tool", `${tool.name} returned a result.`, output),
      toolCallId,
      toolName,
      risk: tool.risk,
    });
    await this.store.save(current);
    return output;
  }

  private toolContext(conversation: Conversation, runId: string, toolCallId: string, active: ActiveRun): ToolExecutionContext {
    return {
      conversationId: conversation.id,
      runId,
      operationId: `${runId}:${toolCallId}`,
      studioSessionId: conversation.studioSessionId,
      signal: active.controller.signal,
      requestInteraction: (questions) => this.requestInteraction(conversation.id, runId, questions),
    };
  }

  private async requestInteraction(conversationId: string, runId: string, questions: AgentQuestion[]) {
    const active = this.active.get(runId);
    if (!active) throw new Error("Run is no longer active");
    const interactionId = randomUUID();
    const answer = new Promise<AgentAnswer[]>((resolve, reject) => {
      active.interactions.set(interactionId, { resolve, reject });
      active.controller.signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
    await this.emitById(conversationId, runId, { type: "interaction_requested", interactionId, questions });
    return answer;
  }

  private async requestApproval(
    conversationId: string,
    runId: string,
    toolCallId: string,
    tool: AgentTool,
    input: Record<string, unknown>,
    summary: string,
    scope: string,
    preview?: JsonValue,
  ) {
    const active = this.active.get(runId);
    if (!active || tool.risk === "read") throw new Error("Run is no longer active");
    const approvalId = randomUUID();
    const hasScripts = typeof preview === "object" && preview !== null && !Array.isArray(preview)
      && Number(preview.scriptCount ?? 0) > 0;
    const allowStripScripts = tool.risk === "external_asset" && hasScripts;
    const response = new Promise<ApprovalDecision>((resolve, reject) => {
      active.approvals.set(approvalId, { resolve, reject, risk: tool.risk, allowStripScripts });
      active.controller.signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
    await this.emitById(conversationId, runId, {
      type: "approval_pending",
      approvalId,
      toolCallId,
      toolName: tool.name,
      input,
      summary,
      scope,
      risk: tool.risk,
      preview,
      allowStripScripts,
    });
    return { approvalId, decision: await response };
  }

  private audit(
    runId: string,
    type: AuditEvent["type"],
    actor: AuditEvent["actor"],
    summary: string,
    details?: JsonValue,
  ): AuditEvent {
    return { id: randomUUID(), timestamp: now(), runId, type, actor, summary, details };
  }

  private throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw new Error("Cancelled by user");
  }

  private async emitById(conversationId: string, runId: string, data: AgentEventData) {
    const conversation = await this.requiredConversation(conversationId);
    await this.emit(conversation, runId, data);
  }

  private async emit(conversation: Conversation, runId: string, data: AgentEventData) {
    const event = {
      ...data,
      sequence: conversation.nextSequence,
      conversationId: conversation.id,
      runId,
      timestamp: now(),
    } as AgentEvent;
    conversation.nextSequence += 1;
    conversation.events.push(event);
    await this.store.save(conversation);
    for (const listener of this.listeners.get(conversation.id) ?? []) listener(event);
  }

  private requiredRun(conversation: Conversation, runId: string) {
    const run = conversation.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private async requiredConversation(id: string) {
    const conversation = await this.store.get(id);
    if (!conversation) throw new Error(`Unknown conversation: ${id}`);
    conversation.approvedScopes ??= [];
    conversation.auditEvents ??= [];
    for (const run of conversation.runs) run.mode ??= "execute";
    return conversation;
  }
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
