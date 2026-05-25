import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { AgentRuntime } from "./runtime.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { Conversation } from "./types.ts";

const rateLimiter = new RateLimiter();

const sessionSchema = z.string().regex(/^[A-Za-z0-9]{6,12}$/);
const startSchema = z.object({
  message: z.string().min(1),
  provider: z.enum(["anthropic", "openrouter", "codex"]),
  model: z.string().min(1),
  mode: z.enum(["execute", "plan"]).default("execute"),
});
const answerSchema = z.object({ answers: z.array(z.union([z.string(), z.array(z.string())])) });
const approvalSchema = z.object({ decision: z.enum(["allow_once", "allow_scope", "insert_without_scripts", "deny"]) });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const publicConversation = (conversation: Conversation) => {
  const { accessTokenHash: _token, ...safe } = conversation;
  return safe;
};

export function createAgentRouter(runtime: AgentRuntime) {
  const router = Router();
  const bootstrapKey = process.env.STUD_AGENT_API_KEY;

  const bearer = (req: Request) => {
    const header = req.header("authorization") ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  };
  const bootstrapAllowed = (req: Request) => !bootstrapKey || bearer(req) === bootstrapKey;
  const authorize = async (req: Request, id: string) => {
    const conversation = await runtime.getConversation(id);
    if (!conversation) return null;
    if (!conversation.accessTokenHash) return bootstrapAllowed(req) ? conversation : null;
    const actual = Buffer.from(digest(bearer(req)));
    const expected = Buffer.from(conversation.accessTokenHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? conversation : null;
  };

  router.get("/config", (req, res) => {
    if (!bootstrapAllowed(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      providers: {
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        codex: Boolean(process.env.STUD_CODEX_ACCESS_TOKEN),
      },
    });
  });

  router.post("/conversations", async (req, res) => {
    if (!bootstrapAllowed(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = sessionSchema.safeParse(req.body?.studioSessionId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Studio session id" });
      return;
    }
    const accessToken = randomBytes(32).toString("base64url");
    const conversation = await runtime.createConversation(parsed.data, digest(accessToken));
    res.status(201).json({ conversation: publicConversation(conversation), accessToken });
  });

  router.get("/conversations/:conversationId", async (req, res) => {
    const conversation = await authorize(req, req.params.conversationId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    res.json(publicConversation(conversation));
  });

  router.post("/conversations/:conversationId/runs", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const rlKey = `${parsed.data.provider}:${req.params.conversationId}`;
      await rateLimiter.acquire(rlKey, parsed.data.model, parsed.data.provider);
      const release = () => rateLimiter.release(rlKey);
      res.status(202).json(await runtime.startRun(req.params.conversationId, { ...parsed.data, rateLimiterRelease: release }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/conversations/:conversationId/runs/:runId/cancel", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const cancelled = await runtime.cancelRun(req.params.conversationId, req.params.runId);
    res.status(cancelled ? 202 : 404).json({ cancelled });
  });

  router.post("/conversations/:conversationId/runs/:runId/interactions/:interactionId", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const answered = await runtime.answerInteraction(req.params.conversationId, req.params.runId, req.params.interactionId, parsed.data.answers);
    res.status(answered ? 202 : 404).json({ answered });
  });

  router.post("/conversations/:conversationId/runs/:runId/approvals/:approvalId", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const parsed = approvalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const answered = await runtime.answerApproval(
      req.params.conversationId,
      req.params.runId,
      req.params.approvalId,
      parsed.data.decision,
    );
    res.status(answered ? 202 : 404).json({ answered });
  });

  router.get("/conversations/:conversationId/events", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
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
    const unsubscribe = await runtime.subscribe(req.params.conversationId, after, send);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  return router;
}
