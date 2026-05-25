import { randomUUID } from "node:crypto";
import type {
  AgentAnswer,
  AgentEvent,
  AgentEventData,
  AgentQuestion,
  AgentRun,
  AgentToolRegistry,
  Conversation,
  ConversationStore,
  JsonValue,
  ModelDriverFactory,
  StartRunInput,
} from "./types.ts";

const now = () => new Date().toISOString();

type Interaction = {
  resolve: (answers: AgentAnswer[]) => void;
  reject: (error: Error) => void;
};

type ActiveRun = {
  controller: AbortController;
  interactions: Map<string, Interaction>;
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
  ) {}

  createConversation(studioSessionId: string) {
    return this.store.create(studioSessionId);
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
      provider: input.provider,
      model: input.model,
      startedAt: now(),
      iterations: 0,
    };
    conversation.messages.push({ role: "user", content: input.message });
    conversation.runs.push(run);
    const active: ActiveRun = { controller: new AbortController(), interactions: new Map() };
    this.active.set(run.id, active);
    await this.emit(conversation, run.id, {
      type: "run_started",
      provider: input.provider,
      model: input.model,
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
    for (const interaction of active?.interactions.values() ?? []) {
      interaction.reject(new Error("Cancelled by user"));
    }
    return true;
  }

  async answerInteraction(runId: string, interactionId: string, answers: AgentAnswer[]) {
    const active = this.active.get(runId);
    const interaction = active?.interactions.get(interactionId);
    if (!interaction) return false;
    active?.interactions.delete(interactionId);
    interaction.resolve(answers);
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
          const output = await this.tools.execute(call.name, call.input, {
            conversationId,
            runId,
            studioSessionId: next.studioSessionId,
            signal: active.controller.signal,
            requestInteraction: (questions) => this.requestInteraction(conversationId, runId, questions),
          });
          const withResult = await this.requiredConversation(conversationId);
          withResult.messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            output,
          });
          await this.emit(withResult, runId, {
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            output,
          });
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

  private async requestInteraction(conversationId: string, runId: string, questions: AgentQuestion[]) {
    const active = this.active.get(runId);
    if (!active) throw new Error("Run is no longer active");
    const interactionId = randomUUID();
    const answer = new Promise<AgentAnswer[]>((resolve, reject) => {
      active.interactions.set(interactionId, { resolve, reject });
      active.controller.signal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
    });
    await this.emitById(conversationId, runId, {
      type: "interaction_requested",
      interactionId,
      questions,
    });
    return answer;
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
    return conversation;
  }
}
