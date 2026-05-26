import { describe, expect, it } from "vitest";
import { buildChatSubmission, classifyToolOutput } from "../intents";

describe("chat intents", () => {
  it("submits plan as a read-only runtime mode with explicit constraints", () => {
    const result = buildChatSubmission("Add a lobby", ["plan"]);

    expect(result.mode).toBe("plan");
    expect(result.message).toContain("read-only implementation plan");
    expect(result.message).toContain("Do not create, edit, insert, delete, or execute");
    expect(result.message).toContain("Add a lobby");
  });

  it("turns toolbox and docs chips into supported server instructions", () => {
    const result = buildChatSubmission("Build a forest", ["toolbox", "docs"]);

    expect(result.mode).toBe("execute");
    expect(result.message).toContain("roblox_toolbox_search");
    expect(result.message).toContain("roblox_ask_user");
    expect(result.message).toContain("retrieved Roblox documentation context");
  });

  it("labels policy denials and failures as visible tool outcomes", () => {
    expect(classifyToolOutput({ denied: true, reason: "Approval denied" })).toEqual({
      status: "denied",
      error: "Approval denied",
    });
    expect(classifyToolOutput({ error: "Studio disconnected" })).toEqual({
      status: "error",
      error: "Studio disconnected",
    });
  });
});
