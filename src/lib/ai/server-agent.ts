import { bridgeUrl } from "@/lib/bridge/config";
import { getSessionId } from "@/lib/bridge/session";
import type { Message } from "@/stores/chat";
import type { Tier } from "@/lib/ai/profiles";

type QuestionOption = { label: string; value?: string; imageUrl?: string; description?: string };
type Question = { question: string; options?: Array<string | QuestionOption>; type: "single" | "multi" | "text" };
type Answer = string | string[];
export type ApprovalDecision = "allow_once" | "allow_scope" | "insert_without_scripts" | "deny";
export type ApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  scope: string;
  scopeDescription?: string;
  risk: string;
  preview?: unknown;
  allowStripScripts?: boolean;
  elevated?: boolean;
};
type AgentEvent = {
  sequence: number;
  runId: string;
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  interactionId?: string;
  questions?: Question[];
  decision?: ApprovalDecision;
  planId?: string;
  steps?: PlanStep[];
  summary?: string;
  taskId?: string;
  title?: string;
  status?: string;
  note?: string;
  before?: number;
  after?: number;
  iteration?: number;
} & Partial<ApprovalRequest>;
type ServerMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
  | { role: "tool"; toolCallId: string; toolName: string; output: unknown };
type Run = { id: string; status: string };
type Conversation = { id: string; studioSessionId: string; messages: ServerMessage[]; runs: Run[]; events?: AgentEvent[] };
type ConversationAccess = { id: string; accessToken: string };

export type PlanStep = {
  index: number;
  title: string;
  description: string;
  toolNames: string[];
  risk: "read" | "low_mutation" | "destructive";
  scope: string;
  estimatedChanges: number;
  summary?: string;
  toolName?: string;
};

export type TaskUpdate = {
  taskId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  note?: string;
  runId: string;
};

export type ContextCompacted = {
  before: number;
  after: number;
  iteration: number;
};

const conversationKey = (sessionId: string) => `corpus_agent_conversation_${sessionId}`;
const bootstrapKey = import.meta.env.VITE_CORPUS_AGENT_API_KEY as string | undefined;
const devToken = () => localStorage.getItem("corpus_dev_mode_token") || "";

const request = async (path: string, init?: RequestInit, token?: string) => {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const credential = token ?? bootstrapKey;
  if (credential) headers.set("Authorization", `Bearer ${credential}`);
  const dev = devToken();
  if (dev) headers.set("X-Corpus-Dev-Token", dev);
  return fetch(bridgeUrl(path), { ...init, headers, credentials: "include" });
};

function storedAccess(sessionId: string) {
  const stored = localStorage.getItem(conversationKey(sessionId));
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as ConversationAccess;
    return parsed.id && parsed.accessToken ? parsed : null;
  } catch {
    localStorage.removeItem(conversationKey(sessionId));
    return null;
  }
}

async function getConversation() {
  const sessionId = getSessionId();
  const stored = storedAccess(sessionId);
  if (stored) {
    const response = await request(`/agent/conversations/${stored.id}`, undefined, stored.accessToken);
    if (response.ok) return { conversation: await response.json() as Conversation, access: stored };
    localStorage.removeItem(conversationKey(sessionId));
  }
  const response = await request("/agent/conversations", {
    method: "POST",
    body: JSON.stringify({ studioSessionId: sessionId }),
  });
  if (!response.ok) throw new Error(`Could not create server conversation: ${response.status}`);
  const body = await response.json() as { conversation: Conversation; accessToken: string };
  const access = { id: body.conversation.id, accessToken: body.accessToken };
  localStorage.setItem(conversationKey(sessionId), JSON.stringify(access));
  return { conversation: body.conversation, access };
}

export async function clearServerConversation() {
  await cancelServerRun();
  localStorage.removeItem(conversationKey(getSessionId()));
}

export async function getServerProviderConfig() {
  try {
    const response = await request("/agent/config");
    if (!response.ok) return { ready: false };
    const body = await response.json() as { ready: boolean; devModeAllowed?: boolean };
    return body;
  } catch {
    return { ready: false };
  }
}

export async function loadServerMessages(): Promise<Array<Omit<Message, "id" | "createdAt">>> {
  const { conversation } = await getConversation();
  const messages: Array<Omit<Message, "id" | "createdAt">> = [];
  for (const message of conversation.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.input,
          status: "running",
        })),
      });
      continue;
    }
    const assistant = [...messages].reverse().find((item) => item.role === "assistant" && item.toolCalls?.some((call) => call.id === message.toolCallId));
    const call = assistant?.toolCalls?.find((item) => item.id === message.toolCallId);
    if (call) {
      call.status = "complete";
      call.result = message.output;
    }
  }
  return messages;
}

export type MutationResult = {
  transactionId: string;
  toolCallId?: string;
  toolName: string;
  path: string;
  before?: string;
  after?: string;
  beforeSource?: string;
  afterSource?: string;
  undoWaypoint?: string;
  revisionBefore?: string;
  revisionAfter?: string;
  created?: boolean;
  deleted?: boolean;
};

export interface ServerChatCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => void;
  onToolResult: (toolResult: { id: string; output: unknown }) => void;
  onInteraction: (interactionId: string, questions: Question[]) => Promise<Answer[]>;
  onApproval: (approval: ApprovalRequest) => Promise<ApprovalDecision>;
  onMutationResult?: (result: MutationResult) => void;
  onPlanSteps?: (plan: { planId: string; summary: string; steps: PlanStep[] }) => void;
  onTaskUpdate?: (task: TaskUpdate) => void;
  onContextCompacted?: (notice: ContextCompacted) => void;
  onRunId?: (runId: string) => void;
  onFinish: () => void;
  onError: (error: Error) => void;
}

let active: { conversationId: string; accessToken: string; runId: string; controller: AbortController } | null = null;

async function handleEvent(
  event: AgentEvent,
  access: ConversationAccess,
  runId: string,
  callbacks: ServerChatCallbacks,
  resolvedInteractions: Set<string>,
  resolvedApprovals: Set<string>,
) {
  if (event.runId !== runId) return false;
  if (event.type === "text_delta") callbacks.onToken(event.text ?? "");
  if (event.type === "tool_call") callbacks.onToolCall({
    id: event.toolCallId ?? "",
    name: event.toolName ?? "",
    input: event.input ?? {},
  });
  if (event.type === "tool_result") callbacks.onToolResult({ id: event.toolCallId ?? "", output: event.output });
  if (event.type === "interaction_requested") {
    if (resolvedInteractions.has(event.interactionId ?? "")) return false;
    const answers = await callbacks.onInteraction(event.interactionId ?? "", event.questions ?? []);
    await request(`/agent/conversations/${access.id}/runs/${runId}/interactions/${event.interactionId}`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    }, access.accessToken);
    resolvedInteractions.add(event.interactionId ?? "");
  }
  if (event.type === "approval_pending") {
    if (resolvedApprovals.has(event.approvalId ?? "")) return false;
    const decision = await callbacks.onApproval({
      approvalId: event.approvalId ?? "",
      toolCallId: event.toolCallId ?? "",
      toolName: event.toolName ?? "",
      summary: event.summary ?? "",
      scope: event.scope ?? "",
      scopeDescription: event.scopeDescription,
      risk: event.risk ?? "",
      preview: event.preview,
      allowStripScripts: event.allowStripScripts,
      elevated: event.elevated,
    });
    await request(`/agent/conversations/${access.id}/runs/${runId}/approvals/${event.approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }, access.accessToken);
    resolvedApprovals.add(event.approvalId ?? "");
  }
  if (event.type === "context_snapshot") {
    console.log("[agent] context_snapshot:", event);
  }
  if (event.type === "mutation_result" && callbacks.onMutationResult) {
    callbacks.onMutationResult({
      transactionId: (event as unknown as { transactionId: string }).transactionId,
      toolCallId: (event as unknown as { toolCallId?: string }).toolCallId,
      toolName: event.toolName ?? "",
      path: (event as unknown as { path: string }).path ?? "",
      before: (event as unknown as { before?: string }).before,
      after: (event as unknown as { after?: string }).after,
      beforeSource: (event as unknown as { beforeSource?: string }).beforeSource,
      afterSource: (event as unknown as { afterSource?: string }).afterSource,
      undoWaypoint: (event as unknown as { undoWaypoint?: string }).undoWaypoint,
      revisionBefore: (event as unknown as { revisionBefore?: string }).revisionBefore,
      revisionAfter: (event as unknown as { revisionAfter?: string }).revisionAfter,
      created: (event as unknown as { created?: boolean }).created,
      deleted: (event as unknown as { deleted?: boolean }).deleted,
    });
  }
  if (event.type === "plan_steps_proposed" && callbacks.onPlanSteps) {
    callbacks.onPlanSteps({
      planId: event.planId ?? "",
      summary: event.summary ?? "",
      steps: event.steps ?? [],
    });
  }
  if (event.type === "task_update" && callbacks.onTaskUpdate) {
    callbacks.onTaskUpdate({
      taskId: event.taskId ?? "",
      title: event.title ?? "Task",
      status: (event.status as TaskUpdate["status"]) ?? "pending",
      note: event.note,
      runId,
    });
  }
  if (event.type === "context_compacted" && callbacks.onContextCompacted) {
    callbacks.onContextCompacted({
      before: event.before ?? 0,
      after: event.after ?? 0,
      iteration: event.iteration ?? 0,
    });
  }
  if (event.type === "interaction_resolved") resolvedInteractions.add(event.interactionId ?? "");
  if (event.type === "approval_resolved") resolvedApprovals.add(event.approvalId ?? "");
  if (event.type === "run_completed" || event.type === "run_cancelled") {
    callbacks.onFinish();
    return true;
  }
  if (event.type === "run_error") throw new Error(event.error ?? "Agent run failed");
  return false;
}

async function followRun(access: ConversationAccess, runId: string, callbacks: ServerChatCallbacks) {
  const controller = new AbortController();
  active = { conversationId: access.id, accessToken: access.accessToken, runId, controller };
  let sequence = 0;
  const snapshot = await request(`/agent/conversations/${access.id}`, undefined, access.accessToken);
  const saved = snapshot.ok ? await snapshot.json() as Conversation : undefined;
  const resolvedInteractions = new Set(saved?.events?.filter((event) => event.type === "interaction_resolved").map((event) => event.interactionId ?? ""));
  const resolvedApprovals = new Set(saved?.events?.filter((event) => event.type === "approval_resolved").map((event) => event.approvalId ?? ""));
  try {
    while (!controller.signal.aborted) {
      const response = await request(`/agent/conversations/${access.id}/events?after=${sequence}`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      }, access.accessToken);
      if (!response.ok || !response.body) throw new Error(`Agent stream failed: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as AgentEvent;
          if (event.sequence <= sequence) continue;
          sequence = event.sequence;
          if (await handleEvent(event, access, runId, callbacks, resolvedInteractions, resolvedApprovals)) return;
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    callbacks.onError(failure);
    throw failure;
  } finally {
    if (active?.runId === runId) active = null;
  }
}

export async function sendServerMessage(
  message: string,
  tier: Tier,
  mode: "execute" | "plan",
  callbacks: ServerChatCallbacks,
  devModel?: string,
  fullAccess?: boolean,
) {
  const { conversation, access } = await getConversation();
  const response = await request(`/agent/conversations/${conversation.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ message, tier, mode, ...(devModel ? { devModel } : {}), ...(fullAccess ? { fullAccess } : {}) }),
  }, access.accessToken);
  const result = await response.json() as { id?: string; error?: string };
  if (!response.ok || !result.id) throw new Error(result.error ?? "Unable to start run");
  callbacks.onRunId?.(result.id);
  return followRun(access, result.id, callbacks);
}

export async function resumeServerRun(callbacks: ServerChatCallbacks) {
  const { conversation, access } = await getConversation();
  const run = [...conversation.runs].reverse().find((item) => item.status === "running");
  if (!run) return false;
  void followRun(access, run.id, callbacks);
  return true;
}

export async function cancelServerRun() {
  if (!active) return;
  await request(`/agent/conversations/${active.conversationId}/runs/${active.runId}/cancel`, {
    method: "POST",
    body: "{}",
  }, active.accessToken);
}

export async function approveServerPlan(planId: string) {
  const { access } = await getConversation();
  const response = await request(`/agent/conversations/${access.id}/plans/${planId}/approve`, {
    method: "POST",
    body: "{}",
  }, access.accessToken);
  if (!response.ok) throw new Error(`Could not approve plan: ${response.status}`);
}

export async function rejectServerPlan(planId: string) {
  const { access } = await getConversation();
  const response = await request(`/agent/conversations/${access.id}/plans/${planId}/reject`, {
    method: "POST",
    body: "{}",
  }, access.accessToken);
  if (!response.ok) throw new Error(`Could not reject plan: ${response.status}`);
}

export async function restoreServerRun(runId: string) {
  const { access } = await getConversation();
  const response = await request(`/agent/conversations/${access.id}/runs/${runId}/restore`, {
    method: "POST",
    body: "{}",
  }, access.accessToken);
  if (!response.ok) throw new Error(`Could not restore run: ${response.status}`);
}

export async function fetchSuggestions(lastText: string, toolNames: string[]) {
  const { access } = await getConversation();
  const response = await request(`/agent/conversations/${access.id}/suggestions`, {
    method: "POST",
    body: JSON.stringify({ lastText, toolNames }),
  }, access.accessToken);
  if (!response.ok) return [];
  const body = await response.json() as { suggestions?: string[] };
  return body.suggestions ?? [];
}
