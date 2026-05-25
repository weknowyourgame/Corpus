import { createHash } from "node:crypto";

export type ConflictResult =
  | { conflict: false }
  | { conflict: true; reason: string; storedHash: string; currentHash: string };

export class ScriptRevisionTracker {
  private readonly revisions = new Map<string, string>();

  private hash(source: string): string {
    return createHash("sha256").update(source).digest("hex").slice(0, 12);
  }

  private key(sessionId: string, path: string): string {
    return `${sessionId}::${path}`;
  }

  record(sessionId: string, path: string, source: string): string {
    const hash = this.hash(source);
    this.revisions.set(this.key(sessionId, path), hash);
    return hash;
  }

  check(sessionId: string, path: string, currentSource: string): ConflictResult {
    const k = this.key(sessionId, path);
    const stored = this.revisions.get(k);
    if (!stored) return { conflict: false };
    const currentHash = this.hash(currentSource);
    if (stored === currentHash) return { conflict: false };
    return {
      conflict: true,
      reason: `Script was modified externally since last read (stored: ${stored}, current: ${currentHash})`,
      storedHash: stored,
      currentHash,
    };
  }
}
