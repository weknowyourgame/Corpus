import { randomUUID } from "node:crypto";
import { PermissionPolicy, deriveScopeInfo } from "./policy.ts";
import { parseAtMentions, resolveAtMentions, buildContextBlock } from "./context.ts";
import { buildRagContext } from "./rag.ts";
import { compactMessages, needsCompaction, TIER_MAX_TOKENS } from "./compact.ts";
import { extractMemories, formatMemories, loadMemories, storeMemories } from "./memory.ts";
import { RobloxStudioMcpGateway, normalizePath } from "./tools.ts";
import { executeBatches } from "./scheduler.ts";
import {
  isFailedToolResult,
  classifyFailure,
  isObligation,
  failureMessage,
  failureHint,
  buildRecoveryCandidates,
  verificationFor,
  buildUnresolvedCorrection,
  type UnresolvedObligation,
} from "./recovery.ts";
import type {
  AgentAnswer,
  AgentTask,
  AgentTaskStatus,
  AgentEvent,
  AgentEventData,
  AgentQuestion,
  AgentRun,
  AgentTool,
  AgentToolCall,
  AgentToolRegistry,
  ApprovalDecision,
  ApprovedPlan,
  AuditEvent,
  Conversation,
  ConversationStore,
  JsonValue,
  ModelDriverFactory,
  PendingApprovalRecord,
  PendingInteractionRecord,
  ProposedPlan,
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
  tasks: Map<string, AgentTask>;
  proposedPlan?: ProposedPlan;
  undoWaypointName?: string;
  /** Failed tool calls still owed a fix. Keyed by `${toolName}::${scope}`. */
  unresolvedFailures: Map<string, UnresolvedObligation>;
  /** Number of times completion was blocked to chase unresolved failures. */
  completionNags: number;
};

type Listener = (event: AgentEvent) => void;

export class AgentRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Synchronous gate set before abort() fires so post-cancel emits are blocked immediately. */
  private readonly cancelledRuns = new Set<string>();
  /** Optional bridge-level cancellation callback wired up after construction. */
  private cancelRunStudioRequestsFn?: (sessionId: string, runId: string) => number;

  constructor(
    private readonly store: ConversationStore,
    private readonly drivers: ModelDriverFactory,
    private readonly tools: AgentToolRegistry,
    private readonly maxIterations = 50,
    private readonly policy = new PermissionPolicy(),
    /** Max automatic repair attempts (repaired retry + fallback) per failed call. */
    private readonly maxRepairAttempts = 2,
    /** Max times completion is blocked to chase unresolved failures before giving up. */
    private readonly maxCompletionNags = 3,
  ) {}

  /**
   * Wire up bridge-level cancellation so cancelRun can also purge queued
   * Studio commands for this run. Call once after construction in server/index.js.
   */
  setCancelRunRequests(fn: (sessionId: string, runId: string) => number): void {
    this.cancelRunStudioRequestsFn = fn;
  }

  /**
   * Should be called once on process bootstrap. Cancels any "running" runs
   * left behind by a previous process and clears their pending approvals /
   * interactions so reconnected clients see consistent state.
   */
  async recoverFromCrash() {
    if (typeof this.store.recoverFromCrash === "function") {
      return this.store.recoverFromCrash();
    }
    return [];
  }

  createConversation(studioSessionId: string, accessTokenHash?: string, userId?: string | null) {
    return this.store.create(studioSessionId, accessTokenHash, userId);
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
      tier: input.tier,
      startedAt: now(),
      iterations: 0,
      fullAccess: input.fullAccess ?? false,
    };
    conversation.messages.push({ role: "user", content: input.message });
    conversation.runs.push(run);
    conversation.auditEvents.push(this.audit(run.id, "prompt", "user", `Prompt received in ${run.mode} mode.`, {
      mode: run.mode,
      message: input.message,
    }));
    await this.store.save(conversation);

    const active: ActiveRun = {
      controller: new AbortController(),
      interactions: new Map(),
      approvals: new Map(),
      tasks: new Map(),
      unresolvedFailures: new Map(),
      completionNags: 0,
    };
    this.active.set(run.id, active);
    await this.emit(conversation, run.id, {
      type: "run_started",
      tier: input.tier,
      mode: run.mode,
    });

    void this.execute(conversation.id, run.id, input).finally(() => {
      this.active.delete(run.id);
      // Keep the cancelledRuns entry for 60 s to gate any background tool ops that
      // outlive the main execute loop (relay requests that resolved just before abort).
      setTimeout(() => this.cancelledRuns.delete(run.id), 60_000);
      input.rateLimiterRelease?.();
    });

    return run;
  }

  async cancelRun(conversationId: string, runId: string) {
    // Synchronous idempotency: if cancellation already in progress, bail immediately
    // without touching the store or emitting duplicate events.
    if (this.cancelledRuns.has(runId)) return false;

    const conversation = await this.requiredConversation(conversationId);
    const run = conversation.runs.find((item) => item.id === runId);
    if (!run || run.status !== "running") return false;

    // Double-check after the await in case a concurrent cancelRun raced here.
    if (this.cancelledRuns.has(runId)) return false;

    // Set the gate BEFORE abort() so the execute loop sees it synchronously
    // in any throwIfAborted / cancelledRuns check that runs after the abort fires.
    this.cancelledRuns.add(runId);

    const active = this.active.get(runId);
    active?.controller.abort("Cancelled by user");

    // Clear queued Studio bridge requests for this run before the plugin polls them.
    const studioCleared = this.cancelRunStudioRequestsFn?.(conversation.studioSessionId, runId) ?? 0;
    console.log(`[agent ${runId.slice(0, 8)}] run cancelled; ${studioCleared} Studio request(s) cleared`);

    for (const pending of active?.interactions.values() ?? []) pending.reject(new Error("Cancelled by user"));
    for (const pending of active?.approvals.values() ?? []) pending.reject(new Error("Cancelled by user"));
    active?.interactions.clear();
    active?.approvals.clear();
    run.status = "cancelled";
    run.completedAt = now();
    run.error = "Cancelled by user";
    conversation.pendingApprovals = (conversation.pendingApprovals ?? []).filter(
      (record) => record.runId !== runId,
    );
    conversation.pendingInteractions = (conversation.pendingInteractions ?? []).filter(
      (record) => record.runId !== runId,
    );
    await this.store.save(conversation);
    await this.emit(conversation, runId, { type: "run_cancelled", reason: "Cancelled by user" });
    return true;
  }

  async answerInteraction(conversationId: string, runId: string, interactionId: string, answers: AgentAnswer[]) {
    const active = this.active.get(runId);
    const interaction = active?.interactions.get(interactionId);
    if (!interaction) return false;
    active?.interactions.delete(interactionId);
    const conversation = await this.requiredConversation(conversationId);
    conversation.pendingInteractions = (conversation.pendingInteractions ?? []).filter(
      (record) => record.interactionId !== interactionId,
    );
    await this.store.save(conversation);
    await this.emit(conversation, runId, { type: "interaction_resolved", interactionId });
    interaction.resolve(answers);
    return true;
  }

  async answerApproval(conversationId: string, runId: string, approvalId: string, decision: ApprovalDecision) {
    const active = this.active.get(runId);
    const approval = active?.approvals.get(approvalId);
    if (!approval) return false;
    // allow_scope is valid for any mutation risk — the user explicitly opted in
    if (decision === "insert_without_scripts" && !approval.allowStripScripts) return false;
    const conversation = await this.requiredConversation(conversationId);
    conversation.auditEvents.push({
      ...this.audit(runId, "approval_decision", "user", `User selected ${decision}.`, { approvalId }),
      decision,
    });
    conversation.pendingApprovals = (conversation.pendingApprovals ?? []).filter(
      (record) => record.approvalId !== approvalId,
    );
    await this.store.save(conversation);
    active?.approvals.delete(approvalId);
    await this.emit(conversation, runId, { type: "approval_resolved", approvalId, decision });
    approval.resolve(decision);
    return true;
  }

  /**
   * Promote the most recently submitted plan to an approved plan. The plan
   * is identified by id so the UI cannot race-approve an older plan.
   */
  async approvePlan(conversationId: string, planId: string) {
    const conversation = await this.requiredConversation(conversationId);
    if (!conversation.proposedPlan || conversation.proposedPlan.planId !== planId) return false;
    const approved: ApprovedPlan = {
      planId: conversation.proposedPlan.planId,
      steps: conversation.proposedPlan.steps,
      summary: conversation.proposedPlan.summary,
      approvedAt: now(),
      consumedStepIndices: [],
    };
    conversation.approvedPlan = approved;
    conversation.proposedPlan = undefined;
    conversation.auditEvents.push({
      ...this.audit("system", "plan_decision", "user", `User approved plan ${planId}.`, { planId }),
      decision: "allow_scope",
    });
    await this.store.save(conversation);
    await this.emit(conversation, "system", { type: "plan_approved", planId, steps: approved.steps });
    return true;
  }

  async rejectPlan(conversationId: string, planId: string) {
    const conversation = await this.requiredConversation(conversationId);
    if (!conversation.proposedPlan || conversation.proposedPlan.planId !== planId) return false;
    conversation.proposedPlan = undefined;
    conversation.auditEvents.push({
      ...this.audit("system", "plan_decision", "user", `User rejected plan ${planId}.`, { planId }),
      decision: "deny",
    });
    await this.store.save(conversation);
    await this.emit(conversation, "system", { type: "plan_rejected", planId });
    return true;
  }

  async restoreRun(conversationId: string, runId: string) {
    const conversation = await this.requiredConversation(conversationId);
    const run = conversation.runs.find((item) => item.id === runId);
    if (!run || !["completed", "cancelled"].includes(run.status)) return false;
    const tool = this.tools.get("mcp__roblox_studio__execute_luau");
    if (!tool) throw new Error("Studio execute_luau tool is unavailable");
    const controller = new AbortController();
    await tool.execute({
      code: `game:GetService("ChangeHistoryService"):Undo()`,
    }, {
      conversationId,
      runId,
      operationId: `${runId}:restore`,
      studioSessionId: conversation.studioSessionId,
      signal: controller.signal,
      requestInteraction: async () => [],
    });
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
      const driver = this.drivers({ tier: input.tier, devModel: input.devModel });
      let fullText = "";
      let contextBlock: string | undefined;
      let codeBlockCorrections = 0;

      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        this.throwIfAborted(active.controller.signal);
        const conversation = await this.requiredConversation(conversationId);
        const run = this.requiredRun(conversation, runId);
        run.iterations = iteration;
        await this.store.save(conversation);

        if (iteration > 1 && needsCompaction(conversation.messages, TIER_MAX_TOKENS[input.tier])) {
          const before = conversation.messages.length;
          conversation.messages = await compactMessages(conversation.messages, active.controller.signal);
          const after = conversation.messages.length;
          await this.store.save(conversation);
          console.log(`[agent] compacted ${before} -> ${after} messages`);
          await this.emit(conversation, runId, { type: "context_compacted", before, after, iteration });
        }

        // On first iteration: build context from @mentions + RAG retrieval
        if (iteration === 1) {
          await this.createRunWaypoint(conversationId, runId, active);
          const relay = this.tools instanceof RobloxStudioMcpGateway ? this.tools.getRelay() : undefined;
          const lastUser = [...conversation.messages].reverse().find((m) => m.role === "user");
          const userText = lastUser?.role === "user" ? lastUser.content : "";

          let mentionBlock: string | undefined;
          if (relay) {
            const mentionPaths = parseAtMentions(userText);
            const mentions: Array<{ path: string; summary: string }> = mentionPaths.length > 0
              ? await resolveAtMentions(mentionPaths, relay, conversation.studioSessionId, active.controller.signal).catch(() => [])
              : [];
            if (mentions.length > 0) {
              mentionBlock = buildContextBlock(true, [], mentions);
              await this.emitById(conversationId, runId, {
                type: "context_snapshot",
                studioConnected: true,
                selectedPaths: [],
                atMentions: mentions,
              });
            }
          }

          const [ragBlock, memories] = await Promise.all([
            buildRagContext(userText, conversation.studioSessionId, {}, active.controller.signal),
            loadMemories(conversation.id).catch(() => []),
          ]);
          const parts = [formatMemories(memories), mentionBlock, ragBlock].filter(Boolean);
          if (parts.length) contextBlock = parts.join("\n\n");
        }

        const turnPromise = driver.generate({
          messages: conversation.messages,
          signal: active.controller.signal,
          systemContext: iteration === 1 ? contextBlock : undefined,
          onTextDelta: async (text) => {
            if (active.controller.signal.aborted) return;
            fullText += text;
            // Use the captured conversation object so nextSequence increments
            // monotonically in-place; re-fetching via emitById returns a stale
            // nextSequence when text_delta skips the snapshot save, causing all
            // tokens to share the same sequence number and be deduplicated away
            // by the SSE consumer.
            await this.emit(conversation, runId, { type: "text_delta", text });
          },
        });
        turnPromise.catch(() => undefined);
        const turn = await Promise.race([
          turnPromise,
          this.abortPromise(active.controller.signal),
        ]);
        this.throwIfAborted(active.controller.signal);

        const next = await this.requiredConversation(conversationId);
        const safeToolCalls = turn.toolCalls.map((call) => ({
          ...call,
          input: this.observableInput(call.name, call.input),
        }));
        next.messages.push({ role: "assistant", content: turn.text, toolCalls: safeToolCalls });
        await this.store.save(next);

        // Detect code generation without tool use: the model wrote code blocks for the
        // user to paste instead of calling write_script/create_instance. Reinject a
        // correction and loop rather than completing with zero actual work done.
        const hasCodeBlock = /```[\s\S]{20,}```/.test(turn.text);
        if (!turn.toolCalls.length && hasCodeBlock && codeBlockCorrections < 3) {
          codeBlockCorrections += 1;
          const correction = `You generated code in your response instead of executing it. Do NOT output code blocks. Use mcp__roblox_studio__create_instance to create scripts, then mcp__roblox_studio__write_script to write the source directly into the project. Execute the work now — do not explain it.`;
          next.messages.push({ role: "user", content: correction });
          await this.store.save(next);
          await this.emitById(conversationId, runId, {
            type: "text_delta",
            text: "\n\n[Agent used code generation instead of tools — retrying with correction]\n\n",
          });
          continue;
        }

        if (!turn.toolCalls.length) {
          // Refuse to summarize completion while failed tool calls remain
          // unresolved. Reinject them as an explicit task and loop. Capped by
          // maxCompletionNags so a genuinely impossible fix cannot spin forever.
          if (active.unresolvedFailures.size > 0 && active.completionNags < this.maxCompletionNags) {
            active.completionNags += 1;
            const correction = buildUnresolvedCorrection([...active.unresolvedFailures.values()]);
            next.messages.push({ role: "user", content: correction });
            await this.store.save(next);
            await this.emitById(conversationId, runId, {
              type: "text_delta",
              text: "\n\n[Unresolved tool failures remain — fixing before completion]\n\n",
            });
            continue;
          }

          const finished = this.requiredRun(next, runId);
          finished.status = "completed";
          finished.completedAt = now();
          await this.store.save(next);
          if (finished.mode === "plan") {
            next.auditEvents.push(this.audit(runId, "plan_proposed", "model", "Read-only plan proposed.", { text: fullText }));
            await this.store.save(next);
            await this.emit(next, runId, { type: "plan_proposed", text: fullText });
            const captured = active.proposedPlan ?? next.proposedPlan;
            if (captured) {
              await this.emit(next, runId, {
                type: "plan_steps_proposed",
                planId: captured.planId,
                steps: captured.steps,
                summary: captured.summary,
              });
            }
          }
          await this.emit(next, runId, { type: "run_completed", text: fullText, iterations: iteration });
          this.extractRunMemoriesInBackground(conversationId, runId, fullText);
          return;
        }

        await this.runToolBatch(conversationId, runId, turn.toolCalls, active);
      }

      const conversation = await this.requiredConversation(conversationId);
      const run = this.requiredRun(conversation, runId);
      run.status = "error";
      run.error = `Reached maximum tool iterations (${this.maxIterations})`;
      run.completedAt = now();
      await this.store.save(conversation);
      await this.emit(conversation, runId, { type: "run_error", error: run.error });
    } catch (error) {
      const conversation = await this.requiredConversation(conversationId);
      const run = this.requiredRun(conversation, runId);
      const cancelled = active.controller.signal.aborted;
      // cancelledRuns is set synchronously before abort() fires, so checking it
      // here covers the race where cancelRun's store-save hasn't landed yet.
      if (cancelled && (run.status === "cancelled" || this.cancelledRuns.has(runId))) return;
      run.status = cancelled ? "cancelled" : "error";
      run.completedAt = now();
      if (cancelled) {
        conversation.pendingApprovals = (conversation.pendingApprovals ?? []).filter(
          (record) => record.runId !== runId,
        );
        conversation.pendingInteractions = (conversation.pendingInteractions ?? []).filter(
          (record) => record.runId !== runId,
        );
      }
      await this.store.save(conversation);
      if (cancelled) {
        await this.emit(conversation, runId, { type: "run_cancelled", reason: "Cancelled by user" });
        return;
      }
      run.error = error instanceof Error ? error.message : String(error);
      await this.store.save(conversation);
      await this.emit(conversation, runId, { type: "run_error", error: run.error });
    }
  }

  private async runToolBatch(
    conversationId: string,
    runId: string,
    calls: AgentToolCall[],
    active: ActiveRun,
  ) {
    for (const call of calls) {
      const observableInput = this.observableInput(call.name, call.input);
      await this.emitById(conversationId, runId, {
        type: "tool_call",
        toolCallId: call.id,
        toolName: call.name,
        input: observableInput,
      });
    }

    const outcomes = await executeBatches(
      calls,
      this.tools,
      (call) => this.handleToolCall(conversationId, runId, call.id, call.name, call.input, active),
      active.controller.signal,
    );

    if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return;

    for (const outcome of outcomes) {
      if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return;
      const next = await this.requiredConversation(conversationId);
      // Re-check after the await — cancelRun may have saved while we awaited the store.
      if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return;
      next.messages.push({
        role: "tool",
        toolCallId: outcome.toolCallId,
        toolName: outcome.toolName,
        output: outcome.output,
      });
      await this.store.save(next);
      await this.emit(next, runId, {
        type: "tool_result",
        toolCallId: outcome.toolCallId,
        toolName: outcome.toolName,
        output: outcome.output,
      });
      await this.maybeEmitMutationResult(conversationId, runId, outcome.toolCallId, outcome.toolName, calls, outcome.output);
      await this.reconcileObligations(conversationId, runId, calls, outcome.toolCallId, outcome.output, active);
    }
  }

  /**
   * After a tool result is recorded, keep the run's unresolved-failure ledger
   * accurate: clear obligations a later success covers, and for fresh failures
   * attempt automatic recovery (repaired retry → safe fallback → verification)
   * before registering anything the model still owes a fix.
   */
  private async reconcileObligations(
    conversationId: string,
    runId: string,
    calls: AgentToolCall[],
    toolCallId: string,
    output: JsonValue,
    active: ActiveRun,
  ) {
    const call = calls.find((item) => item.id === toolCallId);
    if (!call) return;
    const tool = this.tools.get(call.name);
    const scope = tool ? tool.scope(call.input) : call.name;
    const key = `${call.name}::${scope}`;
    const path = typeof call.input.path === "string" ? normalizePath(call.input.path) : undefined;

    if (!isFailedToolResult(output)) {
      this.clearObligations(active, key, path);
      return;
    }

    const cls = classifyFailure(output);
    if (!isObligation(cls)) return;

    if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return;
    const resolved = await this.attemptRecovery(conversationId, runId, call, output, active);
    if (resolved) {
      this.clearObligations(active, key, path);
      return;
    }

    active.unresolvedFailures.set(key, {
      key,
      toolName: call.name,
      scope,
      path,
      error: failureMessage(output),
      hint: failureHint(output),
      class: cls,
    });
  }

  private clearObligations(active: ActiveRun, key: string, path?: string) {
    active.unresolvedFailures.delete(key);
    if (!path) return;
    for (const [obKey, obligation] of active.unresolvedFailures) {
      if (obligation.path && obligation.path === path) active.unresolvedFailures.delete(obKey);
    }
  }

  /**
   * Try the ordered repair candidates for a failed call. Each candidate is
   * executed through the normal governed path (policy + approval still apply),
   * then the mutation is verified with a read tool. Returns true only when a
   * candidate both succeeds and verifies. Bounded by maxRepairAttempts.
   */
  private async attemptRecovery(
    conversationId: string,
    runId: string,
    call: AgentToolCall,
    output: JsonValue,
    active: ActiveRun,
  ): Promise<boolean> {
    const candidates = buildRecoveryCandidates(call, output, normalizePath);
    if (!candidates.length) return false;

    let attempts = 0;
    for (const candidate of candidates) {
      if (attempts >= this.maxRepairAttempts) break;
      if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return false;
      attempts += 1;
      await this.emitById(conversationId, runId, {
        type: "text_delta",
        text: `\n\n[recovery] ${candidate.note}\n\n`,
      });
      const result = await this.runRecoveryTool(conversationId, runId, candidate.name, candidate.input, active);
      if (isFailedToolResult(result)) continue;

      const verified = await this.verifyRecovery(conversationId, runId, call, active);
      if (verified) {
        await this.emitById(conversationId, runId, {
          type: "text_delta",
          text: "\n\n[recovery] resolved and verified\n\n",
        });
        return true;
      }
    }
    return false;
  }

  private async verifyRecovery(
    conversationId: string,
    runId: string,
    call: AgentToolCall,
    active: ActiveRun,
  ): Promise<boolean> {
    const check = verificationFor(call, normalizePath);
    if (!check) return true; // nothing to read back — accept the successful mutation
    if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return false;
    const result = await this.runRecoveryTool(conversationId, runId, check.name, check.input, active);
    return !isFailedToolResult(result);
  }

  /**
   * Execute a recovery sub-step through the governed tool path and record it as
   * a first-class tool call/result in the conversation so the model and UI see
   * the repair attempt. Reuses handleToolCall so policy/approval/audit apply.
   */
  private async runRecoveryTool(
    conversationId: string,
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    active: ActiveRun,
  ): Promise<JsonValue> {
    const toolCallId = randomUUID();
    await this.emitById(conversationId, runId, {
      type: "tool_call",
      toolCallId,
      toolName,
      input: this.observableInput(toolName, input),
    });
    const output = await this.handleToolCall(conversationId, runId, toolCallId, toolName, input, active);
    if (active.controller.signal.aborted || this.cancelledRuns.has(runId)) return output;
    const next = await this.requiredConversation(conversationId);
    next.messages.push({ role: "tool", toolCallId, toolName, output });
    await this.store.save(next);
    await this.emit(next, runId, { type: "tool_result", toolCallId, toolName, output });
    await this.maybeEmitMutationResult(conversationId, runId, toolCallId, toolName, [{ id: toolCallId, name: toolName, input }], output);
    return output;
  }

  private async maybeEmitMutationResult(
    conversationId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    calls: AgentToolCall[],
    output: JsonValue,
  ) {
    if (typeof output !== "object" || output === null || Array.isArray(output)) return;
    const out = output as Record<string, unknown>;
    const hasDiff = "beforeSource" in out || "afterSource" in out || "before" in out || "after" in out;
    const hasTransaction = "transactionId" in out;
    if (!hasDiff && !hasTransaction) return;
    const call = calls.find((item) => item.id === toolCallId);
    const p = typeof out.path === "string"
      ? out.path
      : typeof call?.input.path === "string"
        ? call.input.path
        : typeof call?.input.parent === "string"
          ? call.input.parent
          : "";
    await this.emitById(conversationId, runId, {
      type: "mutation_result",
      transactionId: typeof out.transactionId === "string" ? out.transactionId : toolCallId,
      toolCallId,
      toolName,
      path: p,
      before: typeof out.beforeSource === "string" ? out.beforeSource : typeof out.before === "string" ? out.before : undefined,
      after: typeof out.afterSource === "string" ? out.afterSource : typeof out.after === "string" ? out.after : undefined,
      beforeSource: typeof out.beforeSource === "string" ? out.beforeSource : undefined,
      afterSource: typeof out.afterSource === "string" ? out.afterSource : undefined,
      undoWaypoint: typeof out.undoWaypoint === "string" ? out.undoWaypoint : undefined,
      revisionBefore: typeof out.revisionBefore === "string" ? out.revisionBefore : undefined,
      revisionAfter: typeof out.revisionAfter === "string" ? out.revisionAfter : undefined,
      created: out.created === true,
      deleted: out.deleted === true,
    });
  }

  private async handleToolCall(
    conversationId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    active: ActiveRun,
  ): Promise<JsonValue> {
    const tool = this.tools.get(toolName);
    if (!tool) return { denied: true, reason: `Unknown tool: ${toolName}` };
    const conversation = await this.requiredConversation(conversationId);
    const run = this.requiredRun(conversation, runId);
    const assessment = this.policy.assess(tool, input, conversation, run);
    const safeInput = this.observableInput(toolName, input);
    conversation.auditEvents.push({
      ...this.audit(runId, "tool_requested", "model", assessment.summary, asJson(safeInput)),
      toolCallId,
      toolName,
      risk: tool.risk,
    });
    conversation.auditEvents.push({
      ...this.audit(runId, "policy_decision", "policy", assessment.reason, {
        scope: assessment.scope,
        matchReason: assessment.matchReason ?? null,
        planStepIndex: assessment.planStepIndex ?? null,
      }),
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
      this.throwIfAborted(active.controller.signal);
      const approval = await this.requestApproval(
        conversationId,
        runId,
        toolCallId,
        tool,
        input,
        assessment.summary,
        assessment.scope,
        assessment.scopeDescription,
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
        const { canonicalScope, matchStrategy } = deriveScopeInfo(toolName, assessment.scope);
        current.approvedScopes.push({
          id: randomUUID(),
          toolName,
          scope: assessment.scope,
          matchStrategy,
          canonicalScope,
          approvedAt: now(),
          approvalId: approval.approvalId,
        });
        await this.store.save(current);
      }
    }

    this.throwIfAborted(active.controller.signal);
    const output = await tool.execute(executionInput, context);
    this.throwIfAborted(active.controller.signal);
    const current = await this.requiredConversation(conversationId);
    if (assessment.planStepIndex !== undefined && current.approvedPlan) {
      if (!current.approvedPlan.consumedStepIndices.includes(assessment.planStepIndex)) {
        current.approvedPlan.consumedStepIndices.push(assessment.planStepIndex);
      }
      if (current.approvedPlan.consumedStepIndices.length >= current.approvedPlan.steps.length) {
        current.approvedPlan = undefined;
      }
    }
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
      setProposedPlan: async (plan) => {
        const current = await this.requiredConversation(conversation.id);
        current.proposedPlan = plan;
        current.auditEvents.push(this.audit(runId, "plan_submitted", "model", "Structured plan submitted.", {
          planId: plan.planId,
          stepCount: plan.steps.length,
        }));
        await this.store.save(current);
        active.proposedPlan = plan;
      },
      emitSubagentProgress: async (progress) => {
        await this.emitById(conversation.id, runId, {
          type: "subagent_progress",
          subagentId: progress.subagentId,
          subagentType: progress.subagentType,
          kind: progress.kind,
          message: progress.message,
          iteration: progress.iteration,
        });
      },
      createTask: async (title, description) => {
        const timestamp = now();
        const task: AgentTask = {
          id: randomUUID(),
          title,
          description,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        active.tasks.set(task.id, task);
        await this.emitById(conversation.id, runId, {
          type: "task_update",
          taskId: task.id,
          title: task.title,
          status: task.status,
          note: task.note,
          runId,
        });
        return task;
      },
      updateTask: async (taskId, status: AgentTaskStatus, note) => {
        const existing = active.tasks.get(taskId);
        if (!existing) return null;
        const task: AgentTask = {
          ...existing,
          status,
          note,
          updatedAt: now(),
        };
        active.tasks.set(taskId, task);
        await this.emitById(conversation.id, runId, {
          type: "task_update",
          taskId: task.id,
          title: task.title,
          status: task.status,
          note: task.note,
          runId,
        });
        return task;
      },
      listTasks: () => [...active.tasks.values()],
    };
  }

  private async createRunWaypoint(conversationId: string, runId: string, active: ActiveRun) {
    if (active.undoWaypointName) return;
    const conversation = await this.requiredConversation(conversationId);
    const tool = this.tools.get("mcp__roblox_studio__execute_luau");
    if (!tool) return;
    const waypointName = `Corpus:run-start:${runId.slice(0, 8)}`;
    try {
      await tool.execute({
        code: `game:GetService("ChangeHistoryService"):SetWaypoint(${JSON.stringify(waypointName)})`,
      }, {
        conversationId,
        runId,
        operationId: `${runId}:waypoint`,
        studioSessionId: conversation.studioSessionId,
        signal: active.controller.signal,
        requestInteraction: async () => [],
      });
      active.undoWaypointName = waypointName;
    } catch (error) {
      console.warn(`[agent ${runId.slice(0, 8)}] could not create run waypoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractRunMemoriesInBackground(conversationId: string, runId: string, runText: string) {
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const conversation = await this.requiredConversation(conversationId);
        const facts = await extractMemories(conversation.messages, runText, controller.signal);
        await storeMemories(conversationId, facts);
        if (facts.length) console.log(`[agent ${runId.slice(0, 8)}] stored ${facts.length} session memor${facts.length === 1 ? "y" : "ies"}`);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[agent ${runId.slice(0, 8)}] memory extraction skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
  }

  private async requestInteraction(conversationId: string, runId: string, questions: AgentQuestion[]) {
    const active = this.active.get(runId);
    if (!active) throw new Error("Run is no longer active");
    const interactionId = randomUUID();
    const conversation = await this.requiredConversation(conversationId);
    const record: PendingInteractionRecord = {
      interactionId,
      runId,
      questions,
      createdAt: now(),
    };
    conversation.pendingInteractions = [...(conversation.pendingInteractions ?? []), record];
    await this.store.save(conversation);
    const answer = new Promise<AgentAnswer[]>((resolve, reject) => {
      active.interactions.set(interactionId, { resolve, reject });
      active.controller.signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
    await this.emit(conversation, runId, { type: "interaction_requested", interactionId, questions });
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
    scopeDescription?: string,
    preview?: JsonValue,
  ) {
    const active = this.active.get(runId);
    if (!active || tool.risk === "read") throw new Error("Run is no longer active");
    const approvalId = randomUUID();
    const hasScripts = typeof preview === "object" && preview !== null && !Array.isArray(preview)
      && Number(preview.scriptCount ?? 0) > 0;
    const allowStripScripts = tool.risk === "external_asset" && hasScripts;
    const previewElevated = typeof preview === "object" && preview !== null && !Array.isArray(preview)
      && Boolean((preview as Record<string, unknown>).elevated);
    const elevated = Boolean(tool.isElevated?.(input)) || previewElevated;
    const safeInput = this.observableInput(tool.name, input);
    const conversation = await this.requiredConversation(conversationId);
    const record: PendingApprovalRecord = {
      approvalId,
      runId,
      toolCallId,
      toolName: tool.name,
      input: safeInput,
      summary,
      scope,
      scopeDescription,
      risk: tool.risk as Exclude<ToolRisk, "read">,
      preview,
      allowStripScripts,
      elevated,
      createdAt: now(),
    };
    conversation.pendingApprovals = [...(conversation.pendingApprovals ?? []), record];
    await this.store.save(conversation);
    const response = new Promise<ApprovalDecision>((resolve, reject) => {
      active.approvals.set(approvalId, { resolve, reject, risk: tool.risk, allowStripScripts });
      active.controller.signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
    await this.emit(conversation, runId, {
      type: "approval_pending",
      approvalId,
      toolCallId,
      toolName: tool.name,
      input: safeInput,
      summary,
      scope,
      scopeDescription,
      risk: tool.risk as Exclude<ToolRisk, "read">,
      preview,
      allowStripScripts,
      elevated,
    });
    return { approvalId, decision: await response };
  }

  private observableInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    const tool = this.tools.get(toolName);
    if (!tool?.redactInput) return input;
    try {
      return tool.redactInput(input);
    } catch {
      return input;
    }
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

  private abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cancelled by user"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
  }

  private async emitById(conversationId: string, runId: string, data: AgentEventData) {
    const conversation = await this.requiredConversation(conversationId);
    await this.emit(conversation, runId, data);
  }

  private async emit(conversation: Conversation, runId: string, data: AgentEventData) {
    // Gate: once a run is cancelled, only run_cancelled itself may pass through.
    // This prevents late tool results, mutation results, or run_completed from being
    // appended after cancellation, even if a background tool call raced to completion.
    if (this.cancelledRuns.has(runId) && data.type !== "run_cancelled") {
      console.log(`[agent ${runId.slice(0, 8)}] drop ${data.type} (run cancelled)`);
      return;
    }
    const event = {
      ...data,
      sequence: conversation.nextSequence,
      conversationId: conversation.id,
      runId,
      timestamp: now(),
    } as AgentEvent;
    conversation.nextSequence += 1;
    conversation.events.push(event);
    // Hot path: text deltas go to the append-only event log without
    // rewriting the snapshot. Everything else triggers a full save so the
    // snapshot stays in sync.
    if (typeof this.store.appendEvent === "function") {
      await this.store.appendEvent(conversation.id, event);
      if (data.type !== "text_delta") {
        await this.store.save(conversation);
      }
    } else {
      await this.store.save(conversation);
    }
    this.log(event);
    for (const listener of this.listeners.get(conversation.id) ?? []) listener(event);
  }

  private log(event: AgentEvent) {
    const tag = `[agent ${event.runId.slice(0, 8)}]`;
    if (event.type === "run_started") console.log(`${tag} started tier=${event.tier} mode=${event.mode}`);
    else if (event.type === "tool_call") console.log(`${tag} tool_call ${event.toolName}`);
    else if (event.type === "tool_result") console.log(`${tag} tool_result ${event.toolName}`);
    else if (event.type === "run_completed") console.log(`${tag} completed iterations=${event.iterations}`);
    else if (event.type === "run_cancelled") console.log(`${tag} cancelled: ${event.reason ?? ""}`);
    else if (event.type === "run_error") console.error(`${tag} ERROR: ${event.error}`);
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
    conversation.pendingApprovals ??= [];
    conversation.pendingInteractions ??= [];
    for (const run of conversation.runs) run.mode ??= "execute";
    return conversation;
  }
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
