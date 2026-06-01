import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AgentRuntime } from "./runtime.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { Conversation } from "./types.ts";
import type { CurrentUser } from "../auth.ts";
import { getPrismaClient } from "./prisma.ts";

const rateLimiter = new RateLimiter();

const appSettingsSchema = z.object({
  animationsEnabled: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  compactMode: z.boolean().optional(),
  showToolDetails: z.boolean().optional(),
  autoScrollChat: z.boolean().optional(),
  confirmDestructiveActions: z.boolean().optional(),
  saveHistory: z.boolean().optional(),
  maxHistoryMessages: z.number().int().min(10).max(500).optional(),
});
const userSettingsPatchSchema = z.object({
  selectedTier: z.enum(["free", "pro", "hyper", "super"]).optional(),
  devMode: z.boolean().optional(),
  devModel: z.string().optional(),
  appSettings: appSettingsSchema.optional(),
});

const sessionSchema = z.string().regex(/^[A-Za-z0-9]{6,12}$/);
const startSchema = z.object({
  message: z.string().min(1),
  tier: z.enum(["free", "pro", "hyper", "super"]).default("pro"),
  devModel: z.string().optional(),
  mode: z.enum(["execute", "plan"]).default("execute"),
  fullAccess: z.boolean().optional(),
});
const answerSchema = z.object({ answers: z.array(z.union([z.string(), z.array(z.string())])) });
const approvalSchema = z.object({ decision: z.enum(["allow_once", "allow_scope", "insert_without_scripts", "deny"]) });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const devModeAllowed = (req: Request) => {
  if (process.env.STUD_DEV_MODE_ENABLED !== "true") return false;
  const token = process.env.STUD_DEV_MODE_TOKEN;
  if (!token) return true;
  return req.header("x-stud-dev-token") === token;
};
// Full access: server env gates whether the client can enable it at all.
// STUD_FULL_ACCESS_ENABLED=true → allowed on this server.
// STUD_FULL_ACCESS_TOKEN (optional) → client must send X-Stud-Full-Access-Token header.
const fullAccessAllowed = (req: Request) => {
  if (process.env.STUD_FULL_ACCESS_ENABLED !== "true") return false;
  const requiredToken = process.env.STUD_FULL_ACCESS_TOKEN;
  if (!requiredToken) return true;
  return req.header("x-stud-full-access-token") === requiredToken;
};
const publicConversation = (conversation: Conversation) => {
  const { accessTokenHash: _token, ...safe } = conversation;
  return safe;
};

type AuthRequest = Request & { currentUser?: CurrentUser };

export function createAgentRouter(
  runtime: AgentRuntime,
  auth: {
    requireUser: (req: AuthRequest, res: Response, next: NextFunction) => void;
  },
) {
  const router = Router();
  router.use(auth.requireUser);

  const bearer = (req: Request) => {
    const header = req.header("authorization") ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  };
  const tokenMatches = (req: Request, conversation: Conversation) => {
    if (!conversation.accessTokenHash) return true;
    const token = bearer(req);
    if (!token) return false;
    const actual = Buffer.from(digest(token));
    const expected = Buffer.from(conversation.accessTokenHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const ownsConversation = (req: AuthRequest, conversation: Conversation) => {
    const user = req.currentUser;
    if (!user) return false;
    if (user.id) return conversation.userId === user.id;
    return user.anonymous && !conversation.userId;
  };
  const authorize = async (req: AuthRequest, id: string) => {
    const conversation = await runtime.getConversation(id);
    if (!conversation) return null;
    if (!ownsConversation(req, conversation)) return null;
    // Session-authenticated (non-anonymous) users: the cookie session + userId
    // match is the primary identity proof. The bearer access token is secondary
    // and may not be present when accessing from a new device or browser session.
    const user = req.currentUser;
    if (user?.id && !user.anonymous) return conversation;
    // Anonymous sessions have no persistent userId, so the bearer token is the
    // only per-conversation identity guard.
    return tokenMatches(req, conversation) ? conversation : null;
  };

  // --- User settings ---

  router.get("/user/settings", async (req: AuthRequest, res) => {
    const userId = req.currentUser?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const row = await getPrismaClient().userSettings.findUnique({ where: { userId } });
    if (!row) {
      res.json({ settings: null });
      return;
    }
    res.json({
      settings: {
        selectedTier: row.selectedTier,
        devMode: row.devMode,
        devModel: row.devModel,
        appSettings: row.appSettings,
      },
    });
  });

  router.patch("/user/settings", async (req: AuthRequest, res) => {
    const userId = req.currentUser?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const parsed = userSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { selectedTier, devMode, devModel, appSettings } = parsed.data;
    const existing = await getPrismaClient().userSettings.findUnique({ where: { userId } });
    const mergedAppSettings = {
      ...(existing?.appSettings as Record<string, unknown> ?? {}),
      ...(appSettings ?? {}),
    };
    const row = await getPrismaClient().userSettings.upsert({
      where: { userId },
      update: {
        ...(selectedTier !== undefined ? { selectedTier } : {}),
        ...(devMode !== undefined ? { devMode } : {}),
        ...(devModel !== undefined ? { devModel } : {}),
        appSettings: mergedAppSettings,
      },
      create: {
        userId,
        selectedTier: selectedTier ?? "pro",
        devMode: devMode ?? false,
        devModel: devModel ?? "",
        appSettings: mergedAppSettings,
      },
    });
    res.json({
      settings: {
        selectedTier: row.selectedTier,
        devMode: row.devMode,
        devModel: row.devModel,
        appSettings: row.appSettings,
      },
    });
  });

  router.get("/config", (req, res) => {
    const useCfGateway = Boolean(process.env.AI_GATEWAY_URL && process.env.CLOUDFLARE_API_TOKEN);
    const useOpenRouterDirect = Boolean(process.env.OPENROUTER_API_KEY);
    res.json({
      ready: useCfGateway || useOpenRouterDirect,
      mode: useCfGateway ? "cloudflare-gateway" : "openrouter-direct",
      devModeAllowed: devModeAllowed(req),
      fullAccessAllowed: fullAccessAllowed(req),
      tiers: ["free", "pro", "hyper", "super"],
    });
  });

  router.get("/models", async (req, res) => {
    if (!devModeAllowed(req)) {
      res.json({ models: [] });
      return;
    }
    // Models list always comes from OpenRouter directly (not through CF gateway)
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      res.json({ models: [] });
      return;
    }
    try {
      const upstream = await fetch("https://openrouter.ai/api/v1/models?supported_parameters=tools", {
        headers: {
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://stud.dev",
          "X-OpenRouter-Title": "Stud",
        },
      });
      if (!upstream.ok) {
        res.json({ models: [] });
        return;
      }
      const data = await upstream.json() as { data?: Array<{ id: string; name: string; description?: string; context_length?: number }> };
      const models = (data.data ?? [])
        .map((m) => ({ id: m.id, name: m.name || m.id, description: m.description?.slice(0, 80) || `${m.context_length?.toLocaleString() ?? "?"} ctx` }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  router.post("/conversations", async (req, res) => {
    const parsed = sessionSchema.safeParse(req.body?.studioSessionId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Studio session id" });
      return;
    }
    const accessToken = randomBytes(32).toString("base64url");
    const conversation = await runtime.createConversation(parsed.data, digest(accessToken), (req as AuthRequest).currentUser?.id ?? null);
    res.status(201).json({ conversation: publicConversation(conversation), accessToken });
  });

  router.get("/conversations", async (req: AuthRequest, res) => {
    if (!process.env.DATABASE_URL) {
      res.json({ conversations: [] });
      return;
    }
    const userId = req.currentUser?.id;
    const rows = await getPrismaClient().agentConversation.findMany({
      where: userId ? { userId } : { userId: null },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    res.json({
      conversations: rows.map((row) => publicConversation({
        id: row.id,
        userId: row.userId,
        studioSessionId: row.studioSessionId,
        accessTokenHash: row.accessTokenHash ?? undefined,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        nextSequence: row.nextSequence,
        messages: [],
        runs: [],
        events: [],
        approvedScopes: [],
        auditEvents: [],
        pendingApprovals: [],
        pendingInteractions: [],
      })),
    });
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
    if (parsed.data.devModel && !devModeAllowed(req)) {
      res.status(403).json({ error: "Dev mode is disabled for this deployment" });
      return;
    }
    // Full access: client may request it only if server env permits.
    const clientWantsFullAccess = parsed.data.fullAccess === true;
    if (clientWantsFullAccess && !fullAccessAllowed(req)) {
      res.status(403).json({ error: "Full access mode is not enabled on this server" });
      return;
    }
    try {
      const rlKey = `${parsed.data.tier}:${req.params.conversationId}`;
      await rateLimiter.acquire(rlKey, parsed.data.tier);
      const release = () => rateLimiter.release(rlKey);
      res.status(202).json(await runtime.startRun(req.params.conversationId, {
        message: parsed.data.message,
        tier: parsed.data.tier,
        devModel: parsed.data.devModel,
        mode: parsed.data.mode,
        fullAccess: clientWantsFullAccess && fullAccessAllowed(req),
        rateLimiterRelease: release,
      }));
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

  router.post("/conversations/:conversationId/plans/:planId/approve", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const ok = await runtime.approvePlan(req.params.conversationId, req.params.planId);
    res.status(ok ? 202 : 404).json({ approved: ok });
  });

  router.post("/conversations/:conversationId/plans/:planId/reject", async (req, res) => {
    if (!await authorize(req, req.params.conversationId)) {
      res.status(404).json({ error: "Conversation not found or unauthorized" });
      return;
    }
    const ok = await runtime.rejectPlan(req.params.conversationId, req.params.planId);
    res.status(ok ? 202 : 404).json({ rejected: ok });
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

  router.post("/improve-prompt", async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "Missing prompt" });
      return;
    }
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) {
      res.json({ improved: prompt, error: "Stud model access is unavailable on this server" });
      return;
    }
    const gatewayBase = (process.env.AI_GATEWAY_URL ?? "").replace(/\/$/, "");
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    const url = gatewayBase
      ? `${gatewayBase}/openrouter/chat/completions`
      : "https://openrouter.ai/api/v1/chat/completions";
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://stud.dev",
          "X-OpenRouter-Title": "Stud",
          ...(gatewayBase && cfToken ? { "cf-aig-authorization": `Bearer ${cfToken}` } : {}),
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite-preview-06-17",
          messages: [
            {
              role: "system",
              content: "You are a prompt improvement assistant for Stud, an AI agent for Roblox Studio. Improve the user's rough prompt to be clearer and more effective. Return ONLY the improved prompt text, no preamble.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 500,
        }),
      });
      if (!upstream.ok) {
        res.json({ improved: prompt, error: "Upstream error" });
        return;
      }
      const data = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
      const improved = data.choices?.[0]?.message?.content?.trim() ?? prompt;
      res.json({ improved });
    } catch {
      res.json({ improved: prompt, error: "Request failed" });
    }
  });

  return router;
}
