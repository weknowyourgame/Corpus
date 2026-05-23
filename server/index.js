/**
 * Stud Bridge Server — Web ↔ Roblox Studio plugin relay
 *
 * Roblox Studio can only make outgoing HTTP requests. This server queues
 * requests from the web app and delivers them to the plugin via polling.
 */

import express from "express";
import cors from "cors";

const PORT = Number(process.env.PORT) || 3001;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,12}$/;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

/** @type {Map<string, { pending: Map<string, PendingRequest>, lastPoll: number, counter: number }>} */
const sessions = new Map();

/** @type {{ code: string, state: string, timestamp: number } | null} */
let oauthCallback = null;

/**
 * @typedef {{ path: string, body?: string }} StudioRequest
 * @typedef {{ status: number, body: string }} StudioResponse
 * @typedef {{ request: StudioRequest, resolve: (r: StudioResponse) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }} PendingRequest
 */

const getSession = (sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  let session = sessions.get(sessionId);
  if (!session) {
    session = { pending: new Map(), lastPoll: 0, counter: 0 };
    sessions.set(sessionId, session);
  }
  return session;
};

const timestamp = () => Date.now();

const isStudioConnected = (session) => session.lastPoll > 0 && timestamp() - session.lastPoll < 2000;

const cleanupSession = (session) => {
  const now = timestamp();
  for (const [id, pending] of session.pending) {
    if (now - pending.createdAt > REQUEST_TIMEOUT_MS) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Request timed out waiting for Studio response"));
      session.pending.delete(id);
    }
  }
};

const nextRequestId = (session) => {
  session.counter += 1;
  return `req_${session.counter}_${timestamp()}`;
};

// --- Session routes (web + plugin) ---

app.get("/stud/sessions/:sessionId/status", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  cleanupSession(session);
  res.json({
    connected: isStudioConnected(session),
    pending_requests: session.pending.size,
    last_poll_time: session.lastPoll ? timestamp() - session.lastPoll : null,
  });
});

app.post("/stud/sessions/:sessionId/request", async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  cleanupSession(session);

  const body = req.body;
  if (!body?.path) {
    res.status(400).json({ error: "Missing request path" });
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
      resolve,
      reject,
      timer,
      createdAt: timestamp(),
    });
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

  const entry = session.pending.entries().next();
  if (entry.done) {
    res.json({ id: null, request: null });
    return;
  }

  const [id, pending] = entry.value;
  res.json({ id, request: pending.request });
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

app.get("/stud/status", (req, res) => {
  const session = getSession(LEGACY_SESSION);
  res.json({
    connected: isStudioConnected(session),
    pending_requests: session.pending.size,
    last_poll_time: session.lastPoll ? timestamp() - session.lastPoll : null,
  });
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
