import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "./types.ts";

export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpServerInfo = {
  name?: string;
  version?: string;
  title?: string;
  instructions?: string;
};

export type McpContent = { type: string; text?: string };

export type McpCallResult = {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: JsonValue;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type McpClientOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * If provided, the client skips spawning a child process and uses these streams directly.
   * Intended for tests.
   */
  streams?: { stdin: Writable; stdout: Readable; stderr?: Readable };
  /** Tag used in logs. */
  label?: string;
};

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "stud-agent", version: "0.1.0" };

export class StudioMcpClient extends EventEmitter {
  private process?: ChildProcess | ChildProcessByStdio<Writable, Readable, Readable>;
  private stdin?: Writable;
  private stdout?: Readable;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected = false;
  private toolList: McpToolSchema[] = [];
  private serverInfo: McpServerInfo = {};
  private disposed = false;
  private lastConnectError?: string;

  constructor(private readonly options: McpClientOptions) {
    super();
  }

  isConnected() {
    return this.connected;
  }

  listTools(): McpToolSchema[] {
    return this.toolList.slice();
  }

  getServerInfo(): McpServerInfo {
    return this.serverInfo;
  }

  getLastConnectError() {
    return this.lastConnectError;
  }

  /**
   * Spawn the server (or attach to provided streams) and complete the MCP handshake.
   * Throws if anything goes wrong; caller can decide to fall back to another transport.
   */
  async connect(timeoutMs = 6000): Promise<void> {
    if (this.connected) return;
    if (this.disposed) throw new Error("MCP client has been disposed");

    if (this.options.streams) {
      this.stdin = this.options.streams.stdin;
      this.stdout = this.options.streams.stdout;
      this.options.streams.stderr?.on("data", (chunk: Buffer) =>
        this.emit("stderr", chunk.toString("utf8")),
      );
    } else {
      const child = spawn(this.options.command, this.options.args ?? ["--stdio"], {
        env: this.options.env ?? process.env,
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      this.stdin = child.stdin!;
      this.stdout = child.stdout!;
      // Suppress EPIPE so a write-after-child-exit doesn't crash the bridge.
      child.stdin!.on("error", () => {});
      child.stderr!.on("data", (chunk: Buffer) =>
        this.emit("stderr", chunk.toString("utf8")),
      );
      child.on("error", (err) => {
        this.lastConnectError = err.message;
        this.failAll(err);
        this.connected = false;
      });
      child.on("exit", (code, signal) => {
        const reason = `StudioMCP process exited (code=${code} signal=${signal ?? "none"})`;
        this.lastConnectError = reason;
        this.failAll(new Error(reason));
        this.connected = false;
        this.emit("exit", { code, signal });
      });
    }

    this.stdout!.on("data", (chunk: Buffer) => this.ingest(chunk));

    try {
      const init = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: CLIENT_INFO,
        },
        timeoutMs,
      ) as { serverInfo?: McpServerInfo; instructions?: string } | undefined;
      this.serverInfo = init?.serverInfo ?? {};
      if (init?.instructions) this.serverInfo.instructions = init.instructions;

      this.notify("notifications/initialized");

      const list = await this.request("tools/list", {}, timeoutMs) as
        | { tools?: McpToolSchema[] }
        | undefined;
      this.toolList = list?.tools ?? [];
      this.connected = true;
      this.emit("connected", { tools: this.toolList, serverInfo: this.serverInfo });
    } catch (err) {
      this.lastConnectError = err instanceof Error ? err.message : String(err);
      await this.dispose();
      throw err;
    }
  }

  /**
   * Force-disconnect the client and reject any in-flight calls.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    this.failAll(new Error("MCP client disposed"));
    if (this.process) {
      try { this.stdin?.destroy(); } catch { /* ignore */ }
      try { this.stdout?.destroy(); } catch { /* ignore */ }
      try { this.process.kill(); } catch { /* ignore */ }
      this.process = undefined;
    }
    this.stdin = undefined;
    this.stdout = undefined;
  }

  /**
   * Call an MCP tool. Throws on transport failure, timeout, or cancellation.
   * The returned `isError` flag is preserved so the caller can decide.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<McpCallResult> {
    if (!this.connected) throw new Error("StudioMCP is not connected");
    if (signal.aborted) throw new Error("Cancelled before MCP call");
    const result = await this.requestWithSignal(
      "tools/call",
      { name, arguments: args },
      signal,
      timeoutMs,
    ) as McpCallResult | undefined;
    if (!result || !Array.isArray(result.content)) {
      throw new Error("Malformed MCP tool result: missing content");
    }
    return result;
  }

  private requestWithSignal(
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error("Cancelled by client"));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    return this.requestWithSignal(method, params, controller.signal, timeoutMs);
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private send(message: unknown) {
    if (!this.stdin || this.stdin.destroyed) {
      throw new Error("StudioMCP stdin is not available");
    }
    this.stdin.write(JSON.stringify(message) + "\n");
  }

  private ingest(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        let parsed: { id?: number; method?: string; result?: unknown; error?: { message?: string } } | undefined;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          this.emit("malformed", line, err);
        }
        if (parsed) this.handleMessage(parsed);
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(message: { id?: number; method?: string; result?: unknown; error?: { message?: string } }) {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `MCP error ${message.id}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message);
      if (message.method === "notifications/tools/list_changed") {
        void this.refreshTools();
      }
    }
  }

  // Re-fetch the tools list — called when Studio signals its tool set changed.
  private async refreshTools(): Promise<void> {
    if (!this.connected || this.disposed) return;
    try {
      const controller = new AbortController();
      const list = await this.requestWithSignal("tools/list", {}, controller.signal, 5000) as
        | { tools?: McpToolSchema[] }
        | undefined;
      this.toolList = list?.tools ?? [];
      this.emit("tools_updated", { tools: this.toolList });
    } catch {
      // non-fatal — tools list stays as-is until next notification
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
