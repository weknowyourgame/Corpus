// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

let server: ChildProcess | undefined;

const waitFor = async <T>(read: () => Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for bridge");
};

afterEach(() => {
  server?.kill();
  server = undefined;
});

describe("Studio relay operation delivery", () => {
  it("polls/responds once, replays a completed operation, and removes aborted queued work", async () => {
    const port = 41000 + Math.floor(Math.random() * 1000);
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        STUD_INTERNAL_RELAY_TOKEN: "test-relay-token",
        STUD_STUDIO_TRANSPORT: "plugin",
      },
      stdio: "ignore",
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok ? true : undefined);

    const created = await (await fetch(`${base}/agent/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studioSessionId: "ABCDEF12" }),
    })).json() as { conversation: { id: string }; accessToken: string };
    expect((await fetch(`${base}/agent/conversations/${created.conversation.id}`)).status).toBe(404);
    expect((await fetch(`${base}/agent/conversations/${created.conversation.id}`, {
      headers: { Authorization: `Bearer ${created.accessToken}` },
    })).status).toBe(200);

    expect((await fetch(`${base}/stud/sessions/ABCDEF12/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/instance/create", body: "{}", operationId: "bypass" }),
    })).status).toBe(403);

    const pending = fetch(`${base}/stud/sessions/ABCDEF12/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stud-Agent-Relay": "test-relay-token" },
      body: JSON.stringify({ path: "/instance/create", body: "{}", operationId: "mutation-1" }),
    });
    const delivery = await waitFor(async () => {
      const body = await (await fetch(`${base}/stud/sessions/ABCDEF12/poll`)).json() as { id: string | null };
      return body.id ? body : undefined;
    });
    await fetch(`${base}/stud/sessions/ABCDEF12/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: delivery.id, response: { status: 200, body: "{\"created\":\"Part\"}" } }),
    });
    expect(await (await pending).json()).toEqual({ created: "Part" });

    const replay = await fetch(`${base}/stud/sessions/ABCDEF12/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stud-Agent-Relay": "test-relay-token" },
      body: JSON.stringify({ path: "/instance/create", body: "{}", operationId: "mutation-1" }),
    });
    expect(await replay.json()).toEqual({ created: "Part" });
    expect(await (await fetch(`${base}/stud/sessions/ABCDEF12/poll`)).json()).toMatchObject({ id: null });

    const controller = new AbortController();
    const aborted = fetch(`${base}/stud/sessions/ABCDEF12/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stud-Agent-Relay": "test-relay-token" },
      body: JSON.stringify({ path: "/instance/create", body: "{}", operationId: "cancel-me" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(async () => {
      const body = await (await fetch(`${base}/stud/sessions/ABCDEF12/poll`)).json() as { id: string | null };
      return body.id ? true : undefined;
    });
    controller.abort();
    await aborted;
    await waitFor(async () => {
      const body = await (await fetch(`${base}/stud/sessions/ABCDEF12/poll`)).json() as { id: string | null };
      return body.id === null ? true : undefined;
    });
  });
});
