import { Router } from "express";
import { z } from "zod";
import type { AgentRuntime } from "./runtime.ts";

const sessionSchema = z.string().regex(/^[A-Za-z0-9]{6,12}$/);
const startSchema = z.object({
  message: z.string().min(1),
  provider: z.enum(["anthropic", "openrouter", "codex"]),
  model: z.string().min(1),
});
const answerSchema = z.object({ answers: z.array(z.union([z.string(), z.array(z.string())])) });

export function createAgentRouter(runtime: AgentRuntime) {
  const router = Router();
  const key = process.env.STUD_AGENT_API_KEY;

  router.use((req, res, next) => {
    if (!key) {
      next();
      return;
    }
    const authorization = req.header("authorization");
    const queryKey = typeof req.query.key === "string" ? req.query.key : "";
    if (authorization !== `Bearer ${key}` && queryKey !== key) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  router.get("/config", (_req, res) => {
    res.json({
      providers: {
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        codex: Boolean(process.env.STUD_CODEX_ACCESS_TOKEN),
      },
    });
  });

  router.post("/conversations", async (req, res) => {
    const parsed = sessionSchema.safeParse(req.body?.studioSessionId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Studio session id" });
      return;
    }
    res.status(201).json(await runtime.createConversation(parsed.data));
  });

  router.get("/conversations/:conversationId", async (req, res) => {
    const conversation = await runtime.getConversation(req.params.conversationId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(conversation);
  });

  router.post("/conversations/:conversationId/runs", async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      res.status(202).json(await runtime.startRun(req.params.conversationId, parsed.data));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/conversations/:conversationId/runs/:runId/cancel", async (req, res) => {
    const cancelled = await runtime.cancelRun(req.params.conversationId, req.params.runId);
    res.status(cancelled ? 202 : 404).json({ cancelled });
  });

  router.post("/conversations/:conversationId/runs/:runId/interactions/:interactionId", async (req, res) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const answered = await runtime.answerInteraction(req.params.runId, req.params.interactionId, parsed.data.answers);
    res.status(answered ? 202 : 404).json({ answered });
  });

  router.get("/conversations/:conversationId/events", async (req, res) => {
    if (!await runtime.getConversation(req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const requested = typeof req.query.after === "string" ? Number(req.query.after) : 0;
    const header = Number(req.header("last-event-id") ?? 0);
    const after = Number.isFinite(requested) ? Math.max(requested, header) : header;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: { sequence: number }) => {
      res.write(`id: ${event.sequence}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    let unsubscribe: (() => void) | undefined;
    unsubscribe = await runtime.subscribe(req.params.conversationId, after, send);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe?.();
    });
  });

  return router;
}
