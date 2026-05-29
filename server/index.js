/**
 * Stud Bridge Server — Web ↔ Roblox Studio plugin relay
 *
 * Roblox Studio can only make outgoing HTTP requests. This server queues
 * requests from the web app and delivers them to the plugin via polling.
 */

import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DevelopmentConversationStore, MemoryConversationStore } from "./agent/store.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { RobloxStudioMcpGateway } from "./agent/tools.ts";
import { OpenCloudClient } from "./agent/open-cloud.ts";
import { createDataStoreTools } from "./agent/datastore-tools.ts";
import { createSubagentTool } from "./agent/subagent.ts";
import { createPlaytestTools } from "./agent/playtest-tools.ts";
import { createModelDriverFactory } from "./agent/drivers.ts";
import { createAgentRouter } from "./agent/routes.ts";
import { StudioMcpClient } from "./agent/mcp-stdio.ts";
import {
  CompositeStudioTransport,
  OfficialMcpTransport,
  PluginRelayTransport,
  readConfiguredTransport,
} from "./agent/studio-transport.ts";

try {
  // Bun auto-loads .env; Node.js needs loadEnvFile (available since 20.12)
  process.loadEnvFile?.(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const PORT = Number(process.env.PORT) || 3001;
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_HOLD_MS = 500; // long-poll hold time; drops idle rate to ~1.7 req/s vs 10/s
const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/;
const AGENT_RELAY_TOKEN = process.env.STUD_INTERNAL_RELAY_TOKEN || randomUUID();
const MUTATING_STUDIO_PATHS = new Set([
  "/script/set",
  "/script/edit",
  "/instance/set",
  "/instance/create",
  "/instance/delete",
  "/instance/clone",
  "/instance/move",
  "/instance/bulk-create",
  "/instance/bulk-delete",
  "/instance/bulk-set",
  "/code/run",
  "/asset/insert",
  "/playtest/start",
  "/playtest/stop",
]);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

/** @type {Map<string, { pending: Map<string, PendingRequest>, completed: Map<string, { response: StudioResponse, completedAt: number }>, lastPoll: number, counter: number }>} */
const sessions = new Map();

/** @type {{ code: string, state: string, timestamp: number } | null} */
let oauthCallback = null;

/**
 * @typedef {{ path: string, body?: string }} StudioRequest
 * @typedef {{ status: number, body: string }} StudioResponse
 * @typedef {{ request: StudioRequest, operationId?: string, resolve: (r: StudioResponse) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, createdAt: number }} PendingRequest
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
  return `req_${session.counter}_${timestamp()}`;
};

const relayStudioRequest = async (sessionId, path, body, signal, operationId) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/stud/sessions/${sessionId}/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Stud-Agent-Relay": AGENT_RELAY_TOKEN },
    body: JSON.stringify({ path, body: body ? JSON.stringify(body) : undefined, operationId }),
    signal,
  });
  const result = await response.json();
  return response.ok ? result : { error: result.error || `Studio request failed: ${response.status}` };
};

// --- Studio transport selection (official MCP stdio vs plugin polling) ---
const configuredTransport = readConfiguredTransport(process.env);
const DEFAULT_MCP_BINARY = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const resolvedMcpBinary = process.env.STUD_STUDIO_MCP_BINARY
  || (existsSync(DEFAULT_MCP_BINARY) ? DEFAULT_MCP_BINARY : undefined);

const pluginTransport = new PluginRelayTransport(relayStudioRequest);
/** @type {OfficialMcpTransport | null} */
let mcpTransport = null;

if (configuredTransport !== "plugin" && resolvedMcpBinary) {
  mcpTransport = new OfficialMcpTransport(); // client is null until first successful connect

  const MCP_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
  let mcpRetryCount = 0;
  let mcpReconnectScheduled = false;

  const scheduleMcpReconnect = () => {
    if (mcpReconnectScheduled) return;
    mcpReconnectScheduled = true;
    const delay = MCP_BACKOFF_MS[Math.min(mcpRetryCount, MCP_BACKOFF_MS.length - 1)];
    mcpRetryCount++;
    console.log(`[studio-mcp] retrying in ${delay / 1000}s (attempt ${mcpRetryCount})`);
    setTimeout(attemptMcpConnect, delay);
  };

  const attemptMcpConnect = async () => {
    mcpReconnectScheduled = false;
    const client = new StudioMcpClient({
      command: resolvedMcpBinary,
      args: (process.env.STUD_STUDIO_MCP_ARGS ?? "--stdio").split(/\s+/).filter(Boolean),
      label: "official-mcp",
    });
    client.on("stderr", (chunk) => {
      if (process.env.STUD_STUDIO_MCP_DEBUG) process.stderr.write(`[studio-mcp] ${chunk}`);
    });
    try {
      await client.connect(15_000);
      mcpRetryCount = 0;
      mcpTransport.setClient(client);
      const tools = client.listTools().map((t) => t.name);
      console.log(`[studio-mcp] connected via ${resolvedMcpBinary}; tools=${tools.join(",")}`);
      // Reconnect automatically if Studio closes or MCP process dies
      client.once("exit", (info) => {
        console.warn(`[studio-mcp] process exited code=${info.code} signal=${info.signal ?? "none"} — will reconnect`);
        scheduleMcpReconnect();
      });
    } catch (err) {
      console.warn(`[studio-mcp] connect failed: ${err.message ?? err}`);
      scheduleMcpReconnect();
    }
  };

  attemptMcpConnect();
} else if (configuredTransport === "mcp") {
  console.warn("[studio-mcp] STUD_STUDIO_TRANSPORT=mcp but StudioMCP binary not found; falling back to plugin");
}

const studioTransport = new CompositeStudioTransport(mcpTransport, pluginTransport, configuredTransport);
const composedRelay = studioTransport.toRelay();

const agentTools = new RobloxStudioMcpGateway(composedRelay);

// DataStore tools via Open Cloud. Approval is delegated to AgentRuntime, which
// emits a single `approval_pending` event per destructive mutation and waits
// for the React approval UI to resolve it.
const openCloudClient = new OpenCloudClient();
if (!openCloudClient.configured) {
  console.warn(
    "[Stud Bridge] Open Cloud DataStore tools are disabled. Set ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_UNIVERSE_ID in .env to enable.",
  );
}
const datastoreTools = createDataStoreTools(openCloudClient);

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
const combinedTools = new CompositeToolRegistry(agentTools, [...datastoreTools, ...playtestTools]);

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

// Durable on-disk snapshot+JSONL conversation store. Tests opt back into
// MemoryConversationStore by setting STUD_AGENT_STORE=memory.
const conversationStore = process.env.STUD_AGENT_STORE === "memory"
  ? new MemoryConversationStore()
  : new DevelopmentConversationStore();
const agentRuntime = new AgentRuntime(
  conversationStore,
  createModelDriverFactory(allTools),
  allTools,
);
// Reconcile any runs that were "running" when a previous bridge process exited.
agentRuntime.recoverFromCrash()
  .then((ids) => { if (ids.length) console.log(`[agent] recovered ${ids.length} crashed conversation(s)`); })
  .catch((err) => console.error("[agent] crash recovery failed:", err));
app.use("/agent", createAgentRouter(agentRuntime));

// --- Session routes (web + plugin) ---

const buildStudioStatus = (session) => {
  const pluginConnected = isStudioConnected(session);
  const mcpConnected = mcpTransport?.isReady() ?? false;
  const preferred = studioTransport.preferred();
  const effective = mcpConnected
    ? "official_mcp"
    : pluginConnected
      ? "plugin_fallback"
      : preferred;
  const activeClient = mcpTransport?.getClient?.() ?? null;
  const tools = activeClient?.listTools().map((t) => t.name) ?? [];
  return {
    connected: pluginConnected || mcpConnected,
    pluginConnected,
    mcpConnected,
    configuredTransport,
    preferredTransport: preferred,
    effectiveTransport: effective,
    lastUsedTransport: studioTransport.lastUsed,
    mcpServer: activeClient?.getServerInfo() ?? null,
    mcpTools: tools,
    mcpError: mcpTransport?.getLastConnectError() ?? null,
    pending_requests: session.pending.size,
    last_poll_time: session.lastPoll ? timestamp() - session.lastPoll : null,
  };
};

app.get("/stud/sessions/:sessionId/status", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  cleanupSession(session);
  res.json(buildStudioStatus(session));
});

app.post("/stud/sessions/:sessionId/request", async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  cleanupSession(session);

  // Fail fast if Studio isn't connected — no point queueing a request that will
  // just time out after 15s and confuse the user.
  if (!isStudioConnected(session)) {
    res.status(503).json({ error: "Roblox Studio is not connected. Open Studio and click Connect in the Stud plugin." });
    return;
  }

  const body = req.body;
  if (!body?.path) {
    res.status(400).json({ error: "Missing request path" });
    return;
  }
  if (MUTATING_STUDIO_PATHS.has(body.path) && req.header("x-stud-agent-relay") !== AGENT_RELAY_TOKEN) {
    res.status(403).json({ error: "Mutating Studio requests must run through the agent permission gateway" });
    return;
  }
  if (body.operationId && session.completed.has(body.operationId)) {
    const cached = session.completed.get(body.operationId).response;
    let parsed;
    try {
      parsed = JSON.parse(cached.body);
    } catch {
      parsed = { raw: cached.body };
    }
    res.status(cached.status).json(parsed);
    return;
  }
  if (body.operationId && [...session.pending.values()].some((pending) => pending.operationId === body.operationId)) {
    res.status(409).json({ error: "Operation is already pending in Studio" });
    return;
  }

  const id = nextRequestId(session);

  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("Request timed out waiting for Studio response"));
    }, REQUEST_TIMEOUT_MS);

    session.pending.set(id, {
      request: { path: body.path, body: body.body },
      operationId: typeof body.operationId === "string" ? body.operationId : undefined,
      resolve,
      reject,
      timer,
      createdAt: timestamp(),
    });

    // Wake up any plugin that's waiting in a long-poll
    if (session.pollWakeup) {
      const wakeup = session.pollWakeup;
      session.pollWakeup = null;
      wakeup({ id, request: { path: body.path, body: body.body } });
    }
  });
  res.on("close", () => {
    const pending = session.pending.get(id);
    if (res.writableEnded || !pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(id);
    pending.reject(new Error("Request cancelled before Studio response"));
  });

  try {
    const studioResponse = await responsePromise;
    let parsed;
    try {
      parsed = JSON.parse(studioResponse.body);
    } catch {
      parsed = { raw: studioResponse.body };
    }
    res.status(studioResponse.status).json(parsed);
  } catch (e) {
    if (res.writableEnded || res.destroyed) return;
    const message = e instanceof Error ? e.message : String(e);
    const status = message.includes("timed out") ? 504 : 500;
    res.status(status).json({ error: message });
  }
});

app.get("/stud/sessions/:sessionId/poll", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  session.lastPoll = timestamp();
  cleanupSession(session);

  // Serve any already-queued request immediately
  const entry = session.pending.entries().next();
  if (!entry.done) {
    const [id, pending] = entry.value;
    res.json({ id, request: pending.request });
    return;
  }

  // Long-poll: hold the connection open until a request arrives or timeout
  let settled = false;
  const settle = (payload) => {
    if (settled) return;
    settled = true;
    session.pollWakeup = null;
    if (!res.writableEnded) res.json(payload);
  };

  const timer = setTimeout(() => settle({ id: null, request: null }), POLL_HOLD_MS);
  session.pollWakeup = settle;

  req.on("close", () => {
    settled = true;
    clearTimeout(timer);
    session.pollWakeup = null;
  });
});

app.post("/stud/sessions/:sessionId/respond", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const { id, response } = req.body;
  if (!id || !response) {
    res.status(400).json({ error: "Missing id or response" });
    return;
  }

  const pending = session.pending.get(id);
  if (!pending) {
    res.json({ error: "Request not found" });
    return;
  }

  clearTimeout(pending.timer);
  session.pending.delete(id);
  if (pending.operationId) session.completed.set(pending.operationId, { response, completedAt: timestamp() });
  pending.resolve(response);
  res.json({ ok: true });
});

// Legacy routes (single default session) for older plugins
const LEGACY_SESSION = "default";

app.get("/stud/poll", (req, res) => {
  const session = getSession(LEGACY_SESSION);
  session.lastPoll = timestamp();
  cleanupSession(session);
  const entry = session.pending.entries().next();
  if (entry.done) {
    res.json({ id: null, request: null });
    return;
  }
  const [id, pending] = entry.value;
  res.json({ id, request: pending.request });
});

app.post("/stud/respond", (req, res) => {
  const session = getSession(LEGACY_SESSION);
  const { id, response } = req.body;
  const pending = session.pending.get(id);
  if (!pending) {
    res.json({ error: "Request not found" });
    return;
  }
  clearTimeout(pending.timer);
  session.pending.delete(id);
  pending.resolve(response);
  res.json({ ok: true });
});

app.post("/stud/request", async (req, res) => {
  req.params = { sessionId: LEGACY_SESSION };
  const session = getSession(LEGACY_SESSION);
  cleanupSession(session);
  const body = req.body;
  if (!body?.path) {
    res.status(400).json({ error: "Missing request path" });
    return;
  }
  if (MUTATING_STUDIO_PATHS.has(body.path) && req.header("x-stud-agent-relay") !== AGENT_RELAY_TOKEN) {
    res.status(403).json({ error: "Mutating Studio requests must run through the agent permission gateway" });
    return;
  }
  const id = nextRequestId(session);
  try {
    const studioResponse = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error("Request timed out waiting for Studio response"));
      }, REQUEST_TIMEOUT_MS);
      session.pending.set(id, {
        request: { path: body.path, body: body.body },
        resolve,
        reject,
        timer,
        createdAt: timestamp(),
      });
    });
    let parsed;
    try {
      parsed = JSON.parse(studioResponse.body);
    } catch {
      parsed = { raw: studioResponse.body };
    }
    res.status(studioResponse.status).json(parsed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("timed out") ? 504 : 500).json({ error: message });
  }
});

app.get("/stud/status", (_req, res) => {
  const session = getSession(LEGACY_SESSION);
  res.json(buildStudioStatus(session));
});

app.get("/stud/studio/status", (_req, res) => {
  const session = getSession(LEGACY_SESSION);
  res.json(buildStudioStatus(session));
});

// --- OAuth (ChatGPT Plus/Pro) ---

app.get("/auth/callback", (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const error = req.query.error;

  if (error) {
    res.type("html").send(errorPage("Authentication Failed", String(error)));
    return;
  }

  oauthCallback = { code, state, timestamp: timestamp() };
  res.type("html").send(successPage());
});

app.get("/auth/poll", (_req, res) => {
  if (!oauthCallback) {
    res.json({ pending: false });
    return;
  }
  res.json({
    pending: true,
    code: oauthCallback.code,
    state: oauthCallback.state,
  });
});

app.post("/auth/clear", (_req, res) => {
  oauthCallback = null;
  res.json({ ok: true });
});

// --- Codex API proxy (CORS bypass) ---

const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";

app.post("/codex/responses", async (req, res) => {
  const auth = req.headers.authorization;
  const accountId = req.headers["chatgpt-account-id"];

  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  try {
    const upstream = await fetch(CODEX_API, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      res.status(upstream.status).type("text/plain").send(text);
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(Buffer.from(value));
      await pump();
    };
    await pump();
  } catch (e) {
    res.status(502).type("text/plain").send(`Proxy error: ${e}`);
  }
});

// --- Whitelisted fetch proxy (Roblox catalog, models.dev, etc.) ---

const PROXY_ALLOWED = [
  "https://models.dev/",
  "https://catalog.roblox.com/",
  "https://thumbnails.roblox.com/",
  "https://apis.roblox.com/",
  "https://openrouter.ai/",
  "https://api.anthropic.com/",
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
        "User-Agent": "Stud/1.0",
      },
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// --- Health ---

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

const errorPage = (title, detail) => `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fafafa}
.card{background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#ef4444}</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;

const successPage = () => `<!DOCTYPE html>
<html><head><title>Authentication Successful</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fafafa}
.card{background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#22c55e}</style></head><body><div class="card"><h1>Authentication Successful!</h1><p>You can close this window.</p></div></body></html>`;

app.listen(PORT, () => {
  console.log(`[Stud Bridge] http://localhost:${PORT}`);
  console.log("[Stud Bridge] Waiting for web app and Studio plugin...");
});
