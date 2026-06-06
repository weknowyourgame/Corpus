/**
 * Corpus Bridge Server — Web ↔ Roblox Studio plugin relay
 *
 * Roblox Studio can only make outgoing HTTP requests. This server queues
 * requests from the web app and delivers them to the plugin via polling.
 */

import express from "express";
import cors from "cors";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, "studio-tokens.json");
import { DevelopmentConversationStore, MemoryConversationStore, PostgresConversationStore } from "./agent/store.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { createTaskTools, RobloxStudioMcpGateway } from "./agent/tools.ts";
import { OpenCloudClient } from "./agent/open-cloud.ts";
import { createDataStoreTools } from "./agent/datastore-tools.ts";
import { createSubagentTool } from "./agent/subagent.ts";
import { createPlaytestTools } from "./agent/playtest-tools.ts";
import { createModelDriverFactory } from "./agent/drivers.ts";
import { createAgentRouter } from "./agent/routes.ts";
import { createMcpRequestHandler, buildMcpToolsList, ExternalMcpRegistry } from "./agent/mcp-server.ts";
import { PluginRelayTransport } from "./agent/studio-transport.ts";
import { runIngestion } from "./agent/corpus/ingest.ts";
import { corpusConfig } from "./agent/corpus/config.ts";
import { retrieveCorpusContext } from "./agent/corpus/retrieve.ts";
import { getPendingGames } from "./agent/corpus/postgres.ts";
import { getPrismaClient } from "./agent/prisma.ts";
import { startDiscordBot } from "./discord/index.ts";
import {
  logout,
  publicUser,
  requireCurrentUser,
  resolveCurrentUser,
  startLogin,
  verifyLogin,
} from "./auth.ts";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const assertProductionConfig = () => {
  if (process.env.NODE_ENV !== "production") return;
  const failures = [];
  if (process.env.CORPUS_ALLOW_ANONYMOUS === "true") failures.push("CORPUS_ALLOW_ANONYMOUS must be false in production");
  if (process.env.CORPUS_DEV_MODE_ENABLED === "true") failures.push("CORPUS_DEV_MODE_ENABLED must be false in production");
  if (process.env.CORPUS_COOKIE_SECURE !== "true") failures.push("CORPUS_COOKIE_SECURE must be true in production");
  if (!process.env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
  if (failures.length) {
    throw new Error(`Unsafe production config:\n- ${failures.join("\n- ")}`);
  }
};

assertProductionConfig();

const PORT = Number(process.env.PORT) || 3001;
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_HOLD_MS = 500; // long-poll hold time; drops idle rate to ~1.7 req/s vs 10/s
const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

/** @type {Map<string, { pending: Map<string, PendingRequest>, completed: Map<string, { result: unknown, completedAt: number }>, lastPoll: number, counter: number, pollWakeup: null | ((payload: unknown) => void), pluginVersion?: string, capabilities?: string[] }>} */
const sessions = new Map();

// --- Studio token auth ---
// Maps SHA-256(token) → { createdAt, sessionId }
const studioTokens = new Map();

const digestToken = (token) => createHash("sha256").update(token).digest("hex");
const newSessionId = () => randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();

/** Load persisted tokens so server restarts don't break existing Studio setups. */
const loadTokens = async () => {
  if (process.env.DATABASE_URL) {
    const rows = await getPrismaClient().studioToken.findMany({ where: { revokedAt: null } });
    for (const row of rows) {
      studioTokens.set(row.tokenHash, { createdAt: row.createdAt.getTime(), sessionId: row.sessionId, userId: row.userId });
    }
    if (studioTokens.size) console.log(`[Corpus] Loaded ${studioTokens.size} studio token(s) from Postgres`);
    return;
  }
  try {
    const data = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
    for (const [key, entry] of Object.entries(data)) {
      const hash = /^[a-f0-9]{64}$/i.test(key) ? key : digestToken(key);
      studioTokens.set(hash, entry);
    }
    if (studioTokens.size) console.log(`[Corpus] Loaded ${studioTokens.size} studio token(s)`);
  } catch {
    // File doesn't exist yet — fine on first run
  }
};

const saveTokens = () => {
  if (process.env.DATABASE_URL) return;
  writeFileSync(TOKENS_FILE, JSON.stringify(Object.fromEntries(studioTokens), null, 2));
};

await loadTokens();

const persistStudioToken = async (hash, sessionId, userId = null) => {
  if (!process.env.DATABASE_URL) {
    saveTokens();
    return;
  }
  await getPrismaClient().studioToken.upsert({
    where: { tokenHash: hash },
    update: { sessionId, userId, revokedAt: null },
    create: { tokenHash: hash, sessionId, userId },
  });
};

const revokeStudioToken = async (hash) => {
  studioTokens.delete(hash);
  if (!process.env.DATABASE_URL) {
    saveTokens();
    return;
  }
  await getPrismaClient().studioToken.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

const bearer = (req) => {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/** Extract and validate a Studio token.
 * Only accepts tokens that were explicitly generated by /auth/studio-token/generate.
 * Sends 401 and returns null on failure.
 */
const requireToken = (req, res) => {
  const token = (bearer(req) || req.header("X-Corpus-Token") || "").trim();
  if (!token) {
    res.status(401).json({ error: "Missing Studio token" });
    return null;
  }
  const hash = digestToken(token);
  const entry = studioTokens.get(hash);
  if (!entry) {
    res.status(401).json({ error: "Token not recognised. Generate a new one at corpus.com." });
    return null;
  }
  return { token, hash, entry };
};

/**
 * @typedef {{ tool: string, arguments?: Record<string, unknown>, operationId?: string, resolve: (r: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, createdAt: number }} PendingRequest
 */

const getSession = (sessionId) => {
  if (sessionId !== "default" && !SESSION_ID_PATTERN.test(sessionId)) return null;
  let session = sessions.get(sessionId);
  if (!session) {
    session = { pending: new Map(), completed: new Map(), lastPoll: 0, counter: 0, pollWakeup: null };
    sessions.set(sessionId, session);
  }
  return session;
};

const timestamp = () => Date.now();

// Window is POLL_HOLD_MS + generous buffer so long-polled sessions don't flap
const isStudioConnected = (session) => session.lastPoll > 0 && timestamp() - session.lastPoll < 3000;

const cleanupSession = (session) => {
  const now = timestamp();
  for (const [id, pending] of session.pending) {
    if (now - pending.createdAt > REQUEST_TIMEOUT_MS) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Request timed out waiting for Studio response"));
      session.pending.delete(id);
    }
  }
  for (const [id, completed] of session.completed) {
    if (now - completed.completedAt > 5 * 60_000) session.completed.delete(id);
  }
};

const nextRequestId = (session) => {
  session.counter += 1;
  return `op_${session.counter}_${timestamp()}`;
};

/**
 * Small ring buffer of recently-cancelled internal pending IDs.
 * Used to emit a more useful log line when the Studio plugin responds after
 * the pending entry has already been removed by cancelRunRequests().
 */
const recentlyCancelledIds = new Map(); // Map<internalPendingId, timestamp>
const CANCELLED_ID_TTL_MS = 60_000;

const trackCancelledPendingId = (id) => {
  if (recentlyCancelledIds.size >= 300) {
    const cutoff = Date.now() - CANCELLED_ID_TTL_MS;
    for (const [k, ts] of recentlyCancelledIds) {
      if (ts < cutoff) recentlyCancelledIds.delete(k);
    }
  }
  recentlyCancelledIds.set(id, Date.now());
};

/**
 * Cancel all pending Studio bridge requests whose operationId starts with
 * `${runId}:`. Safe to call for any runId regardless of which session it
 * belongs to — only the correct session is touched.
 * Returns the number of requests removed.
 */
const cancelRunRequests = (sessionId, runId) => {
  const session = sessions.get(sessionId);
  if (!session) return 0;
  const prefix = `${runId}:`;
  let cancelled = 0;
  for (const [id, pending] of session.pending) {
    if (pending.operationId?.startsWith(prefix)) {
      clearTimeout(pending.timer);
      session.pending.delete(id);
      trackCancelledPendingId(id);
      pending.reject(new Error("Run cancelled"));
      cancelled++;
    }
  }
  if (cancelled > 0) {
    console.log(`[studio] cancelled ${cancelled} queued Studio request(s) for run ${runId.slice(0, 8)}`);
  }
  return cancelled;
};

const relayStudioRequest = (sessionId, tool, args, signal, operationId) => {
  const session = getSession(sessionId);
  if (!session) return Promise.reject(new Error("Invalid Studio session"));
  cleanupSession(session);
  if (!isStudioConnected(session)) {
    return Promise.reject(new Error("Roblox Studio is not connected. Open Studio and connect the Corpus plugin."));
  }
  if (operationId && session.completed.has(operationId)) {
    return Promise.resolve(session.completed.get(operationId).result);
  }
  if (operationId && [...session.pending.values()].some((pending) => pending.operationId === operationId)) {
    return Promise.reject(new Error("Operation is already pending in Studio"));
  }
  const id = nextRequestId(session);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("Request timed out waiting for Studio response"));
    }, REQUEST_TIMEOUT_MS);
    session.pending.set(id, {
      tool,
      arguments: args ?? {},
      operationId: typeof operationId === "string" ? operationId : undefined,
      resolve,
      reject,
      timer,
      createdAt: timestamp(),
    });
    if (signal.aborted) {
      clearTimeout(timer);
      session.pending.delete(id);
      reject(new Error("Cancelled before Studio response"));
      return;
    }
    signal.addEventListener("abort", () => {
      const pending = session.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pending.delete(id);
      reject(new Error("Cancelled before Studio response"));
    }, { once: true });
    if (session.pollWakeup) {
      const wakeup = session.pollWakeup;
      session.pollWakeup = null;
      wakeup({ id, tool, arguments: args ?? {} });
    }
  });
};

const pluginTransport = new PluginRelayTransport(relayStudioRequest);
const composedRelay = pluginTransport.toRelay();

const agentTools = new RobloxStudioMcpGateway(composedRelay);

// DataStore tools via Open Cloud. Approval is delegated to AgentRuntime, which
// emits a single `approval_pending` event per destructive mutation and waits
// for the React approval UI to resolve it.
const openCloudClient = new OpenCloudClient();
if (!openCloudClient.configured) {
  console.warn(
    "[Corpus Bridge] Open Cloud DataStore tools are disabled. Set ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_UNIVERSE_ID in .env to enable.",
  );
}
const datastoreTools = createDataStoreTools(openCloudClient);
const externalMcpRegistry = await ExternalMcpRegistry.fromEnv();
if (externalMcpRegistry.list().length) {
  console.log(`[agent] loaded ${externalMcpRegistry.list().length} external MCP tool(s)`);
}

/**
 * Composite registry that combines studio gateway tools with DataStore tools.
 */
class CompositeToolRegistry {
  constructor(base, extra) {
    this._base = base;
    this._extra = extra;
  }

  list() {
    return [...this._base.list(), ...this._extra];
  }

  get(name) {
    return this._base.get(name) ?? this._extra.find((t) => t.name === name);
  }
}

const playtestTools = createPlaytestTools(composedRelay);
const taskTools = createTaskTools();
const combinedTools = new CompositeToolRegistry(agentTools, [
  ...datastoreTools,
  ...playtestTools,
  ...taskTools,
  ...externalMcpRegistry.list(),
]);

// Subagent tool references combinedTools for read-only wrapping
const subagentTool = createSubagentTool(combinedTools);

class FinalToolRegistry {
  constructor(base, extra) {
    this._base = base;
    this._extra = extra;
  }

  list() {
    return [...this._base.list(), this._extra];
  }

  get(name) {
    return this._base.get(name) ?? (name === this._extra.name ? this._extra : undefined);
  }
}

const allTools = new FinalToolRegistry(combinedTools, subagentTool);

const createConversationStore = () => {
  if (process.env.CORPUS_AGENT_STORE === "memory") return new MemoryConversationStore();
  if (process.env.CORPUS_AGENT_STORE === "file") return new DevelopmentConversationStore();
  if (process.env.DATABASE_URL) return new PostgresConversationStore();
  return new DevelopmentConversationStore();
};

const conversationStore = createConversationStore();
const agentRuntime = new AgentRuntime(
  conversationStore,
  createModelDriverFactory(allTools),
  allTools,
);
// Wire in bridge-level cancellation so cancelRun can also purge queued Studio requests.
agentRuntime.setCancelRunRequests(cancelRunRequests);
// Reconcile any runs that were "running" when a previous bridge process exited.
agentRuntime.recoverFromCrash()
  .then((ids) => { if (ids.length) console.log(`[agent] recovered ${ids.length} crashed conversation(s)`); })
  .catch((err) => console.error("[agent] crash recovery failed:", err));
const authMiddleware = requireCurrentUser();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.post("/auth/login/start", asyncRoute(startLogin));
app.post("/auth/login/verify", asyncRoute(verifyLogin));
app.post("/auth/logout", asyncRoute(logout));
app.get("/auth/me", asyncRoute(async (req, res) => {
  const user = await resolveCurrentUser(req);
  if (!user) {
    res.status(401).json({ user: null });
    return;
  }
  res.json({ user: publicUser(user) });
}));

app.use("/agent", createAgentRouter(agentRuntime, { requireUser: authMiddleware }, () => externalMcpRegistry.status()));

// --- Cloud Studio routes (web + plugin) ---

const buildStudioStatus = (session) => {
  const pluginConnected = isStudioConnected(session);
  return {
    connected: pluginConnected,
    pluginConnected,
    mcpConnected: false,
    configuredTransport: "plugin",
    preferredTransport: "studio_plugin",
    effectiveTransport: pluginConnected ? "studio_plugin" : "unknown",
    lastUsedTransport: pluginTransport.lastUsed,
    mcpServer: null,
    mcpTools: [],
    mcpError: null,
    pending_requests: session.pending.size,
    last_poll_time: session.lastPoll ? timestamp() - session.lastPoll : null,
    pluginVersion: session.pluginVersion ?? null,
    capabilities: session.capabilities ?? [],
  };
};

const discordStudioStatus = (sessionId) => {
  const session = getSession(sessionId);
  if (!session) {
    return {
      connected: false,
      pluginConnected: false,
      pending_requests: 0,
      last_poll_time: null,
      pluginVersion: null,
      capabilities: [],
    };
  }
  cleanupSession(session);
  return buildStudioStatus(session);
};

const resolveDiscordStudioSession = (tokenOrSessionId) => {
  const input = String(tokenOrSessionId ?? "").trim();
  if (SESSION_ID_PATTERN.test(input)) {
    const sessionId = input.toUpperCase();
    const session = sessions.get(sessionId);
    return { sessionId, studioConnected: session ? isStudioConnected(session) : false };
  }
  const entry = studioTokens.get(digestToken(input));
  if (!entry) return null;
  const session = sessions.get(entry.sessionId);
  return { sessionId: entry.sessionId, studioConnected: session ? isStudioConnected(session) : false };
};

void startDiscordBot({
  runtime: agentRuntime,
  studioStatus: discordStudioStatus,
  resolveStudioSession: resolveDiscordStudioSession,
})
  .catch((error) => console.error("[discord] startup failed:", error instanceof Error ? error.message : error));

// --- Studio token endpoints ---

/** Generate a new studio token. Pass { oldToken } in the body to revoke the previous one. */
app.post("/auth/studio-token/generate", authMiddleware, async (req, res) => {
  const allowAnonymous = process.env.CORPUS_ALLOW_ANONYMOUS === "true";
  const userId = req.currentUser?.id ?? null;
  if (!allowAnonymous && !userId) {
    res.status(401).json({ error: "Sign in to generate a Studio token" });
    return;
  }
  const oldToken = req.body?.oldToken;
  if (oldToken) {
    const oldHash = digestToken(String(oldToken));
    const oldEntry = studioTokens.get(oldHash);
    // Never revoke another user's token via oldToken — skip silently if ownership mismatch
    if (!oldEntry?.userId || oldEntry.userId === userId) {
      await revokeStudioToken(oldHash);
    }
  }
  const token = randomBytes(32).toString("base64url");
  const sessionId = newSessionId();
  const hash = digestToken(token);
  studioTokens.set(hash, { createdAt: Date.now(), sessionId, userId });
  await persistStudioToken(hash, sessionId, userId);
  res.json({ token, sessionId });
});

/** Revoke a token explicitly (called when user clears their token in the web app) */
app.post("/auth/studio-token/revoke", authMiddleware, async (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;
  const tokenUserId = auth.entry.userId ?? null;
  const currentUserId = req.currentUser?.id ?? null;
  // User-owned tokens can only be revoked by their owner
  if (tokenUserId && tokenUserId !== currentUserId) {
    res.status(403).json({ error: "Not your token" });
    return;
  }
  await revokeStudioToken(auth.hash);
  res.json({ ok: true });
});

/** Validate a token and return studio connection status */
app.get("/auth/studio-token/validate", (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;
  const { sessionId } = auth.entry;
  const session = sessions.get(sessionId);
  res.json({
    valid: true,
    sessionId,
    studioConnected: session ? isStudioConnected(session) : false,
  });
});

const handleStudioPoll = (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;

  const { sessionId } = auth.entry;
  const session = getSession(sessionId);
  const pluginVersion = typeof req.query.pluginVersion === "string" ? req.query.pluginVersion : req.header("X-Corpus-Plugin-Version");
  const capabilities = String(req.query.capabilities ?? req.header("X-Corpus-Capabilities") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  session.lastPoll = timestamp();
  if (pluginVersion) session.pluginVersion = pluginVersion;
  if (capabilities.length) session.capabilities = capabilities;
  cleanupSession(session);

  const entry = session.pending.entries().next();
  if (!entry.done) {
    const [id, pending] = entry.value;
    res.json({ id, tool: pending.tool, arguments: pending.arguments ?? {} });
    return;
  }

  let settled = false;
  const settle = (payload) => {
    if (settled) return;
    settled = true;
    session.pollWakeup = null;
    if (!res.writableEnded) res.json(payload);
  };

  const timer = setTimeout(() => settle({ id: null }), POLL_HOLD_MS);
  session.pollWakeup = settle;
  req.on("close", () => {
    settled = true;
    clearTimeout(timer);
    session.pollWakeup = null;
  });
};

const handleStudioRespond = (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;

  const { sessionId } = auth.entry;
  const session = getSession(sessionId);

  const { id, result, isError, error } = req.body;
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }

  const pending = session.pending.get(id);
  if (!pending) {
    // Log whether this looks like a late response for a cancelled run or just unknown.
    if (recentlyCancelledIds.has(id)) {
      console.log(`[studio] ignored late Studio response for cancelled run (id=${id})`);
    } else {
      console.log(`[studio] respond for unknown/timed-out id=${id}`);
    }
    res.json({ error: "Request not found" });
    return;
  }

  clearTimeout(pending.timer);
  session.pending.delete(id);
  const output = isError ? { error: error || "Studio tool failed" } : result;
  if (pending.operationId) session.completed.set(pending.operationId, { result: output, completedAt: timestamp() });
  pending.resolve(output);
  res.json({ ok: true });
};

app.post("/studio/request", async (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;
  const tool = String(req.body?.tool ?? "");
  if (!tool) {
    res.status(400).json({ error: "Missing tool" });
    return;
  }
  const controller = new AbortController();
  try {
    const result = await composedRelay(
      auth.entry.sessionId,
      tool,
      req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {},
      controller.signal,
      `direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/studio/poll", handleStudioPoll);
app.post("/studio/respond", handleStudioRespond);
app.get("/corpus/token/poll", handleStudioPoll);
app.post("/corpus/token/respond", handleStudioRespond);

/** Token-based status — web app polls this to see if Studio is connected */
const handleStudioStatus = (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;

  const { sessionId } = auth.entry;
  const session = getSession(sessionId);
  cleanupSession(session);
  res.json(buildStudioStatus(session));
};

app.get("/studio/status", handleStudioStatus);
app.get("/corpus/token/status", handleStudioStatus);

const mcpHandler = createMcpRequestHandler(allTools, composedRelay);

app.get("/mcp/info", (_req, res) => {
  res.json({
    name: "Corpus",
    description: "Cloud MCP server for Roblox Studio",
    tools: buildMcpToolsList(allTools).map((tool) => tool.name),
  });
});

app.get("/mcp", (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "endpoint", uri: "/mcp" })}\n\n`);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => clearInterval(keepAlive));
});

app.post("/mcp", async (req, res) => {
  const auth = requireToken(req, res);
  if (!auth) return;
  await mcpHandler(req, res, auth.entry.sessionId);
});

// --- Whitelisted fetch proxy (Roblox catalog, models.dev, etc.) ---

const PROXY_ALLOWED = [
  "https://catalog.roblox.com/",
  "https://thumbnails.roblox.com/",
  "https://apis.roblox.com/",
];

app.get("/api/proxy", async (req, res) => {
  const target = String(req.query.url || "");
  const allowed = PROXY_ALLOWED.some((prefix) => target.startsWith(prefix));
  if (!allowed) {
    res.status(403).json({ error: "URL not allowed" });
    return;
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Corpus/1.0",
      },
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// --- Corpus ---

app.get("/corpus/status", async (_req, res) => {
  if (!corpusConfig.enabled) return res.json({ enabled: false });
  if (!corpusConfig.ready) return res.json({ enabled: true, ready: false, missing: corpusConfig.missing });
  try {
    const pending = await getPendingGames();
    res.json({ enabled: true, ready: true, pendingGames: pending.length, pending: pending.map((g) => g.slug) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/corpus/debug", async (_req, res) => {
  if (!corpusConfig.enabled) return res.json({ enabled: false });
  const query = "tycoon dropper income system";
  try {
    const result = corpusConfig.ready
      ? await retrieveCorpusContext({ query, maxChunks: corpusConfig.maxChunks }, corpusConfig)
      : { chunks: [], detectedNiche: null, totalFound: 0 };
    res.json({
      query,
      config: {
        enabled: corpusConfig.enabled,
        ready: corpusConfig.ready,
        missing: corpusConfig.missing,
        minScore: corpusConfig.minScore,
        maxChunks: corpusConfig.maxChunks,
        contextMaxChars: corpusConfig.contextMaxChars,
        indexPrefix: corpusConfig.cloudflare.nicheIndexPrefix,
      },
      result,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/corpus/ingest", async (_req, res) => {
  if (!corpusConfig.ready) {
    return res.status(400).json({ error: "Corpus not ready", missing: corpusConfig.missing });
  }
  try {
    const report = await runIngestion(corpusConfig);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/corpus/games", async (req, res) => {
  const { slug, name, niche, r2Prefix, qualityScore } = req.body ?? {};
  if (!slug || !name || !niche || !r2Prefix) {
    return res.status(400).json({ error: "slug, name, niche, r2Prefix are required" });
  }
  if (!corpusConfig.ready) {
    return res.status(400).json({ error: "Corpus not ready", missing: corpusConfig.missing });
  }
  try {
    const { getPrismaClient } = await import("./agent/corpus/postgres.ts");
    const prisma = getPrismaClient();
    const game = await prisma.game.upsert({
      where: { slug },
      update: { name, niche, r2Prefix, qualityScore: qualityScore ?? 0.7 },
      create: { slug, name, niche, r2Prefix, qualityScore: qualityScore ?? 0.7, ingested: false },
    });
    res.json({ ok: true, game });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Health ---

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});


const server = app.listen(PORT, () => {
  console.log(`[Corpus Bridge] http://localhost:${PORT}`);
  console.log("[Corpus Bridge] Waiting for web app and Studio plugin...");
});
server.on("error", (err) => {
  console.error("[Corpus Bridge] server error:", err);
  process.exit(1);
});
// Under Bun, the node:http server from app.listen() does not reliably hold the
// event loop open, so once startup async work settles the process exits 0 right
// after binding (consistently under `concurrently`). Keep an explicit timer ref.
setInterval(() => {}, 1 << 30);
