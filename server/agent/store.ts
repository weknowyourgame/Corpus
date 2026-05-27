import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  Conversation,
  ConversationStore,
} from "./types.ts";

const now = () => new Date().toISOString();

/**
 * Returns a structural copy of the conversation with the `events` array
 * stripped out. The disk path stores events in a separate append-only log;
 * the snapshot file holds everything else. Keeping these separate is the
 * difference between rewriting an N-megabyte JSON blob on every text-token
 * stream event and appending a single line.
 */
const snapshotShape = (conversation: Conversation) => {
  const { events: _ignored, ...rest } = conversation;
  return rest;
};

/**
 * Persists conversations as a directory per id containing:
 *   - `snapshot.json` (atomic write of conversation state minus events)
 *   - `events.jsonl`  (append-only newline-delimited event log)
 *
 * This avoids the previous behaviour where every streamed text token
 * triggered a full rewrite of the conversation JSON. It also gives us a
 * natural way to detect a crashed run on bootstrap.
 */
export class DevelopmentConversationStore implements ConversationStore {
  constructor(private readonly dir = join(process.cwd(), ".stud", "agent-conversations")) {}

  private conversationDir(id: string) {
    return join(this.dir, id);
  }

  private snapshotPath(id: string) {
    return join(this.conversationDir(id), "snapshot.json");
  }

  private eventLogPath(id: string) {
    return join(this.conversationDir(id), "events.jsonl");
  }

  private legacyPath(id: string) {
    return join(this.dir, `${id}.json`);
  }

  async create(studioSessionId: string, accessTokenHash?: string) {
    const timestamp = now();
    const conversation: Conversation = {
      id: randomUUID(),
      studioSessionId,
      accessTokenHash,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      messages: [],
      runs: [],
      events: [],
      approvedScopes: [],
      auditEvents: [],
      pendingApprovals: [],
      pendingInteractions: [],
    };
    await this.save(conversation);
    return conversation;
  }

  async get(id: string) {
    const conversation = await this.readSnapshot(id);
    if (!conversation) return null;
    conversation.events = await this.readEventLog(id);
    // text_delta events update the JSONL log but not the snapshot, so the
    // snapshot's nextSequence may lag the log. Recompute it from the
    // observed event log so subsequent emits don't collide.
    if (conversation.events.length > 0) {
      let maxSeq = 0;
      for (const event of conversation.events) {
        if (event.sequence > maxSeq) maxSeq = event.sequence;
      }
      if (maxSeq + 1 > conversation.nextSequence) {
        conversation.nextSequence = maxSeq + 1;
      }
    }
    return conversation;
  }

  async save(conversation: Conversation) {
    await mkdir(this.conversationDir(conversation.id), { recursive: true });
    const next = { ...conversation, updatedAt: now() };
    const snapshot = snapshotShape(next);
    const tmp = `${this.snapshotPath(conversation.id)}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.snapshotPath(conversation.id));
    conversation.updatedAt = next.updatedAt;
    // If a legacy single-file record exists, delete it on first migrated save.
    await unlink(this.legacyPath(conversation.id)).catch(() => undefined);
  }

  async appendEvent(conversationId: string, event: AgentEvent) {
    await mkdir(this.conversationDir(conversationId), { recursive: true });
    await appendFile(this.eventLogPath(conversationId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async recoverFromCrash() {
    const recovered: string[] = [];
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    for (const entry of entries) {
      const full = join(this.dir, entry);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      const id = info.isDirectory() ? entry : entry.replace(/\.json$/, "");
      const snapshot = await this.readSnapshot(id);
      if (!snapshot) continue;
      const dirty = snapshot.runs.some((run) => run.status === "running");
      const hadPendings = (snapshot.pendingApprovals?.length ?? 0) > 0 || (snapshot.pendingInteractions?.length ?? 0) > 0;
      if (!dirty && !hadPendings) continue;
      const timestamp = now();
      for (const run of snapshot.runs) {
        if (run.status !== "running") continue;
        run.status = "cancelled";
        run.completedAt = timestamp;
        run.error = "Server restarted before this run completed";
        snapshot.auditEvents.push({
          id: randomUUID(),
          timestamp,
          runId: run.id,
          type: "run_recovered",
          actor: "system",
          summary: "Run cancelled after server restart.",
        });
      }
      // Resolve any pending approvals/interactions left behind so the UI
      // does not display ghost prompts after restart.
      const pendingApprovals = snapshot.pendingApprovals ?? [];
      const pendingInteractions = snapshot.pendingInteractions ?? [];
      snapshot.pendingApprovals = [];
      snapshot.pendingInteractions = [];
      snapshot.events = await this.readEventLog(id);
      let seq = snapshot.nextSequence;
      for (const pending of pendingApprovals) {
        const event: AgentEvent = {
          type: "approval_resolved",
          approvalId: pending.approvalId,
          decision: "deny",
          sequence: seq++,
          conversationId: id,
          runId: pending.runId,
          timestamp,
        };
        snapshot.events.push(event);
        await this.appendEvent(id, event);
      }
      for (const pending of pendingInteractions) {
        const event: AgentEvent = {
          type: "interaction_resolved",
          interactionId: pending.interactionId,
          sequence: seq++,
          conversationId: id,
          runId: pending.runId,
          timestamp,
        };
        snapshot.events.push(event);
        await this.appendEvent(id, event);
      }
      snapshot.nextSequence = seq;
      await this.save(snapshot);
      recovered.push(id);
    }
    return recovered;
  }

  private async readSnapshot(id: string): Promise<Conversation | null> {
    const direct = await readFile(this.snapshotPath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (direct) {
      const parsed = JSON.parse(direct) as Conversation;
      ensureDefaults(parsed);
      return parsed;
    }
    // Backwards compat: read the previous single-file layout once. We do not
    // write to that path again.
    const legacy = await readFile(this.legacyPath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!legacy) return null;
    const parsed = JSON.parse(legacy) as Conversation;
    ensureDefaults(parsed);
    return parsed;
  }

  private async readEventLog(id: string): Promise<AgentEvent[]> {
    const file = await open(this.eventLogPath(id), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) return [];
    try {
      const events: AgentEvent[] = [];
      const stream = file.createReadStream({ encoding: "utf8" });
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            try {
              events.push(JSON.parse(line) as AgentEvent);
            } catch {
              // Skip malformed lines rather than failing the entire conversation load.
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) {
        try { events.push(JSON.parse(buffer.trim()) as AgentEvent); } catch { /* ignore */ }
      }
      return events;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async deleteAll() {
    await rm(this.dir, { recursive: true, force: true });
  }
}

const ensureDefaults = (conversation: Conversation) => {
  conversation.approvedScopes ??= [];
  conversation.auditEvents ??= [];
  conversation.pendingApprovals ??= [];
  conversation.pendingInteractions ??= [];
  conversation.events ??= [];
};

export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  async create(studioSessionId: string, accessTokenHash?: string) {
    const timestamp = now();
    const conversation: Conversation = {
      id: randomUUID(),
      studioSessionId,
      accessTokenHash,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      messages: [],
      runs: [],
      events: [],
      approvedScopes: [],
      auditEvents: [],
      pendingApprovals: [],
      pendingInteractions: [],
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

  async appendEvent(conversationId: string, event: AgentEvent) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.events.push(structuredClone(event));
    if (event.sequence + 1 > conversation.nextSequence) {
      conversation.nextSequence = event.sequence + 1;
    }
  }
}
