import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationStore } from "./types.ts";

const now = () => new Date().toISOString();

export class DevelopmentConversationStore implements ConversationStore {
  constructor(private readonly dir = join(process.cwd(), ".stud", "agent-conversations")) {}

  private path(id: string) {
    return join(this.dir, `${id}.json`);
  }

  async create(studioSessionId: string) {
    const timestamp = now();
    const conversation: Conversation = {
      id: randomUUID(),
      studioSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      messages: [],
      runs: [],
      events: [],
    };
    await this.save(conversation);
    return conversation;
  }

  async get(id: string) {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Conversation;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async save(conversation: Conversation) {
    await mkdir(this.dir, { recursive: true });
    const next = { ...conversation, updatedAt: now() };
    const tmp = `${this.path(conversation.id)}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path(conversation.id));
    conversation.updatedAt = next.updatedAt;
  }
}

export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  async create(studioSessionId: string) {
    const timestamp = now();
    const conversation: Conversation = {
      id: randomUUID(),
      studioSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      messages: [],
      runs: [],
      events: [],
    };
    this.conversations.set(conversation.id, structuredClone(conversation));
    return conversation;
  }

  async get(id: string) {
    const conversation = this.conversations.get(id);
    return conversation ? structuredClone(conversation) : null;
  }

  async save(conversation: Conversation) {
    conversation.updatedAt = now();
    this.conversations.set(conversation.id, structuredClone(conversation));
  }
}

