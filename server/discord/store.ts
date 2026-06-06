import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getPrismaClient } from "../agent/prisma.ts";
import type { DiscordProject, DiscordProjectInput } from "./types.ts";

const now = () => new Date().toISOString();

const projectSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  channelId: z.string(),
  ownerDiscordId: z.string(),
  conversationId: z.string(),
  studioSessionId: z.string(),
  lastRunId: z.string().nullable().optional(),
  disconnectedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const fileSchema = z.array(projectSchema);

const hasDatabase = () => Boolean(process.env.DATABASE_URL);

const fromRow = (row: {
  id: string;
  guildId: string;
  channelId: string;
  ownerDiscordId: string;
  conversationId: string;
  studioSessionId: string;
  lastRunId: string | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DiscordProject => ({
  id: row.id,
  guildId: row.guildId,
  channelId: row.channelId,
  ownerDiscordId: row.ownerDiscordId,
  conversationId: row.conversationId,
  studioSessionId: row.studioSessionId,
  lastRunId: row.lastRunId,
  disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class DiscordProjectStore {
  constructor(private readonly filePath = join(process.cwd(), ".corpus", "discord-projects.json")) {}

  async getActiveByChannel(channelId: string) {
    const project = await this.getByChannel(channelId);
    return project && !project.disconnectedAt ? project : null;
  }

  async connect(input: DiscordProjectInput) {
    if (hasDatabase()) {
      const row = await getPrismaClient().discordProject.upsert({
        where: { channelId: input.channelId },
        update: {
          guildId: input.guildId,
          ownerDiscordId: input.ownerDiscordId,
          conversationId: input.conversationId,
          studioSessionId: input.studioSessionId,
          lastRunId: null,
          disconnectedAt: null,
        },
        create: input,
      });
      return fromRow(row);
    }

    const projects = await this.readFile();
    const existing = projects.find((project) => project.channelId === input.channelId);
    const timestamp = now();
    const next: DiscordProject = existing
      ? {
          ...existing,
          ...input,
          lastRunId: null,
          disconnectedAt: null,
          updatedAt: timestamp,
        }
      : {
          id: randomUUID(),
          ...input,
          lastRunId: null,
          disconnectedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    await this.writeFile([
      ...projects.filter((project) => project.channelId !== input.channelId),
      next,
    ]);
    return next;
  }

  async disconnect(channelId: string) {
    if (hasDatabase()) {
      const row = await getPrismaClient().discordProject.update({
        where: { channelId },
        data: { disconnectedAt: new Date() },
      }).catch(() => null);
      return row ? fromRow(row) : null;
    }

    const projects = await this.readFile();
    const existing = projects.find((project) => project.channelId === channelId);
    if (!existing) return null;
    const next = {
      ...existing,
      disconnectedAt: now(),
      updatedAt: now(),
    };
    await this.writeFile([
      ...projects.filter((project) => project.channelId !== channelId),
      next,
    ]);
    return next;
  }

  async setLastRun(channelId: string, runId: string) {
    if (hasDatabase()) {
      await getPrismaClient().discordProject.update({
        where: { channelId },
        data: { lastRunId: runId },
      }).catch(() => undefined);
      return;
    }

    const projects = await this.readFile();
    const next = projects.map((project) => project.channelId === channelId
      ? { ...project, lastRunId: runId, updatedAt: now() }
      : project);
    await this.writeFile(next);
  }

  private async getByChannel(channelId: string) {
    if (hasDatabase()) {
      const row = await getPrismaClient().discordProject.findUnique({ where: { channelId } });
      return row ? fromRow(row) : null;
    }
    const projects = await this.readFile();
    return projects.find((project) => project.channelId === channelId) ?? null;
  }

  private async readFile() {
    const raw = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    });
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  }

  private async writeFile(projects: DiscordProject[]) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(projects, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
