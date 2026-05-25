// @vitest-environment node
import { describe, it, expect } from "vitest";
import { ScriptRevisionTracker } from "./conflict.ts";

describe("ScriptRevisionTracker", () => {
  it("recording then checking same content returns no conflict", () => {
    const tracker = new ScriptRevisionTracker();
    tracker.record("session1", "game.Workspace.Script", "print('hello')");
    const result = tracker.check("session1", "game.Workspace.Script", "print('hello')");
    expect(result.conflict).toBe(false);
  });

  it("recording old content then checking new content returns conflict", () => {
    const tracker = new ScriptRevisionTracker();
    tracker.record("session1", "game.Workspace.Script", "print('hello')");
    const result = tracker.check("session1", "game.Workspace.Script", "print('world')");
    expect(result.conflict).toBe(true);
    if (result.conflict) {
      expect(result.reason).toContain("modified externally");
      expect(result.storedHash).toBeDefined();
      expect(result.currentHash).toBeDefined();
      expect(result.storedHash).not.toBe(result.currentHash);
    }
  });

  it("checking without prior record returns no conflict", () => {
    const tracker = new ScriptRevisionTracker();
    const result = tracker.check("session1", "game.Workspace.Script", "print('hello')");
    expect(result.conflict).toBe(false);
  });

  it("tracks different paths independently", () => {
    const tracker = new ScriptRevisionTracker();
    tracker.record("session1", "game.Workspace.Script1", "v1");
    tracker.record("session1", "game.Workspace.Script2", "v2");
    expect(tracker.check("session1", "game.Workspace.Script1", "v1").conflict).toBe(false);
    expect(tracker.check("session1", "game.Workspace.Script2", "v2").conflict).toBe(false);
    expect(tracker.check("session1", "game.Workspace.Script1", "v2").conflict).toBe(true);
  });

  it("tracks different sessions independently", () => {
    const tracker = new ScriptRevisionTracker();
    tracker.record("sessionA", "game.Workspace.Script", "v1");
    tracker.record("sessionB", "game.Workspace.Script", "v2");
    expect(tracker.check("sessionA", "game.Workspace.Script", "v1").conflict).toBe(false);
    expect(tracker.check("sessionB", "game.Workspace.Script", "v2").conflict).toBe(false);
  });
});
