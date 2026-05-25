import { bridgeUrl } from "@/lib/bridge/config";
import { getSessionId } from "@/lib/bridge/session";
import type { Message } from "@/stores/chat";
import type { ProviderType } from "@/lib/providers/types";

type QuestionOption = { label: string; value?: string; imageUrl?: string; description?: string };
type Question = { question: string; options?: Array<string | QuestionOption>; type: "single" | "multi" | "text" };
type Answer = string | string[];
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
  reason?: string;
  interactionId?: string;
  questions?: Question[];
};
type ServerMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
  | { role: "tool"; toolCallId: string; toolName: string; output: unknown };
type Conversation = { id: string; studioSessionId: string; messages: ServerMessage[] };

const conversationKey = (sessionId: string) => `stud_agent_conversation_${sessionId}`;
const key = import.meta.env.VITE_STUD_AGENT_API_KEY as string | undefined;

const request = async (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(bridgeUrl(path), { ...init, headers });
};

async function getConversation() {
  const sessionId = getSessionId();
  const stored = localStorage.getItem(conversationKey(sessionId));
  if (stored) {
    const response = await request(`/agent/conversations/${stored}`);
    if (response.ok) return await response.json() as Conversation;
  }
  const response = await request("/agent/conversations", {
    method: "POST",
    body: JSON.stringify({ studioSessionId: sessionId }),
  });
  if (!response.ok) throw new Error(`Could not create server conversation: ${response.status}`);
  const conversation = await response.json() as Conversation;
  localStorage.setItem(conversationKey(sessionId), conversation.id);
  return conversation;
}

export async function clearServerConversation() {
  await cancelServerRun();
  localStorage.removeItem(conversationKey(getSessionId()));
}

export async function getServerProviderConfig() {
  try {
    const response = await request("/agent/config");
    if (!response.ok) return { anthropic: false, openrouter: false, codex: false };
    const body = await response.json() as { providers: Record<ProviderType, boolean> };
    return body.providers;
  } catch {
    return { anthropic: false, openrouter: false, codex: false };
  }
}

export async function loadServerMessages(): Promise<Array<Omit<Message, "id" | "createdAt">>> {
  const conversation = await getConversation();
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

export interface ServerChatCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => void;
  onToolResult: (toolResult: { id: string; output: unknown }) => void;
  onInteraction: (interactionId: string, questions: Question[]) => Promise<Answer[]>;
  onFinish: () => void;
  onError: (error: Error) => void;
}

let active: { conversationId: string; runId: string } | null = null;

export async function sendServerMessage(
  message: string,
  provider: ProviderType,
  model: string,
  callbacks: ServerChatCallbacks,
) {
  const conversation = await getConversation();
  const response = await request(`/agent/conversations/${conversation.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ message, provider, model }),
  });
  const result = await response.json() as { id?: string; error?: string };
  if (!response.ok || !result.id) throw new Error(result.error ?? "Unable to start run");
  const runId = result.id;
  active = { conversationId: conversation.id, runId };

  return new Promise<void>((resolve, reject) => {
    let sequence = 0;
    const auth = key ? `&key=${encodeURIComponent(key)}` : "";
    const stream = new EventSource(bridgeUrl(`/agent/conversations/${conversation.id}/events?after=0${auth}`));
    const finish = () => {
      stream.close();
      active = null;
      resolve();
    };
    stream.onmessage = async (raw) => {
      const event = JSON.parse(raw.data) as AgentEvent;
      if (event.sequence <= sequence) return;
      sequence = event.sequence;
      if (event.runId !== runId) return;
      if (event.type === "text_delta") callbacks.onToken(event.text ?? "");
      if (event.type === "tool_call") callbacks.onToolCall({
        id: event.toolCallId ?? "",
        name: event.toolName ?? "",
        input: event.input ?? {},
      });
      if (event.type === "tool_result") callbacks.onToolResult({ id: event.toolCallId ?? "", output: event.output });
      if (event.type === "interaction_requested") {
        const answers = await callbacks.onInteraction(event.interactionId ?? "", event.questions ?? []);
        await request(`/agent/conversations/${conversation.id}/runs/${runId}/interactions/${event.interactionId}`, {
          method: "POST",
          body: JSON.stringify({ answers }),
        });
      }
      if (event.type === "run_completed") {
        callbacks.onFinish();
        finish();
      }
      if (event.type === "run_cancelled") {
        callbacks.onFinish();
        finish();
      }
      if (event.type === "run_error") {
        const error = new Error(event.error ?? "Agent run failed");
        callbacks.onError(error);
        stream.close();
        active = null;
        reject(error);
      }
    };
    stream.onerror = () => {
      // EventSource reconnect handles transient disconnections and the server replays missed events.
    };
  });
}

export async function cancelServerRun() {
  if (!active) return;
  await request(`/agent/conversations/${active.conversationId}/runs/${active.runId}/cancel`, { method: "POST", body: "{}" });
}
