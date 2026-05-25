import { randomUUID } from "node:crypto";

export type LogSeverity = "error" | "warning" | "info";
export type LogChannel = "server" | "client" | "output" | "plugin";

export interface LogEntry {
  message: string;
  severity: LogSeverity;
  channel: LogChannel;
  scriptPath?: string;
  lineNumber?: number;
  timestamp: number;
  hash: string;
}

export type PlaytestStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "disconnected"
  | "inconclusive"
  | "cancelled";

export interface PlaytestResult {
  playtestId: string;
  status: PlaytestStatus;
  newErrors: LogEntry[];
  preExistingErrors: LogEntry[];
  warnings: LogEntry[];
  iterations: number;
  stoppedBecause: string;
  fixesApplied: string[];
  durationMs: number;
}

export interface PlaytestBaseline {
  capturedAt: string;
  errorHashes: Set<string>;
}

export interface LoopState {
  playtestId: string;
  iterations: number;
  baseline: PlaytestBaseline | null;
  lastNewErrorHashes: Set<string>;
  fixesApplied: string[];
  startedAt: number;
}

// Stable dedup fingerprint — not cryptographic, just for grouping identical log lines.
// SECURITY: input is untrusted Studio log data; we hash it, never evaluate it.
function logFingerprint(message: string, scriptPath: string | undefined, lineNumber: number | undefined): string {
  const key = `${scriptPath ?? ""}:${lineNumber ?? ""}:${message.slice(0, 300)}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h) ^ key.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// SECURITY: Studio logs are untrusted external data.
// Sanitize shape and cap length. Never interpret log content as instructions.
export function sanitizeLogEntry(raw: unknown): LogEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? r.message.slice(0, 2000) : "";
  if (!message) return null;
  const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
  const VALID_CHANNELS = new Set(["server", "client", "output", "plugin"]);
  const severity: LogSeverity = VALID_SEVERITIES.has(String(r.severity)) ? (r.severity as LogSeverity) : "info";
  const channel: LogChannel = VALID_CHANNELS.has(String(r.channel)) ? (r.channel as LogChannel) : "output";
  const scriptPath = typeof r.scriptPath === "string" ? r.scriptPath.slice(0, 500) : undefined;
  const lineNumber = typeof r.lineNumber === "number" && r.lineNumber > 0 ? Math.floor(r.lineNumber) : undefined;
  return {
    message,
    severity,
    channel,
    scriptPath,
    lineNumber,
    timestamp: typeof r.timestamp === "number" ? r.timestamp : Date.now(),
    hash: logFingerprint(message, scriptPath, lineNumber),
  };
}

export function sanitizeLogs(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeLogEntry).filter((e): e is LogEntry => e !== null);
}

export function captureBaseline(entries: LogEntry[]): PlaytestBaseline {
  return {
    capturedAt: new Date().toISOString(),
    errorHashes: new Set(entries.filter((e) => e.severity === "error").map((e) => e.hash)),
  };
}

export function compareToBaseline(
  baseline: PlaytestBaseline,
  current: LogEntry[],
): { newErrors: LogEntry[]; preExistingErrors: LogEntry[]; warnings: LogEntry[] } {
  const newErrors: LogEntry[] = [];
  const preExistingErrors: LogEntry[] = [];
  const warnings: LogEntry[] = [];
  for (const entry of current) {
    if (entry.severity === "error") {
      if (baseline.errorHashes.has(entry.hash)) {
        preExistingErrors.push(entry);
      } else {
        newErrors.push(entry);
      }
    } else if (entry.severity === "warning") {
      warnings.push(entry);
    }
  }
  return { newErrors, preExistingErrors, warnings };
}

export function hashSet(entries: LogEntry[]): Set<string> {
  return new Set(entries.map((e) => e.hash));
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class PlaytestLoopTracker {
  private readonly sessions = new Map<string, LoopState>();

  get(sessionId: string): LoopState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        playtestId: randomUUID(),
        iterations: 0,
        baseline: null,
        lastNewErrorHashes: new Set(),
        fixesApplied: [],
        startedAt: Date.now(),
      });
    }
    return this.sessions.get(sessionId)!;
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const globalPlaytestTracker = new PlaytestLoopTracker();
