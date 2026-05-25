// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseAtMentions, buildContextBlock } from "./context.ts";

describe("parseAtMentions", () => {
  it("extracts a single @mention", () => {
    expect(parseAtMentions("check @game.Workspace.Part")).toEqual(["game.Workspace.Part"]);
  });

  it("extracts multiple mentions", () => {
    const result = parseAtMentions("look at @game.Workspace and @game.ServerScriptService");
    expect(result).toContain("game.Workspace");
    expect(result).toContain("game.ServerScriptService");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no mentions", () => {
    expect(parseAtMentions("no mentions here")).toEqual([]);
  });

  it("deduplicates multiple same mentions", () => {
    const result = parseAtMentions("@game.Workspace and @game.Workspace again");
    expect(result).toEqual(["game.Workspace"]);
  });

  it("handles empty string", () => {
    expect(parseAtMentions("")).toEqual([]);
  });
});

describe("buildContextBlock", () => {
  it("includes Selected when paths provided", () => {
    const block = buildContextBlock(true, ["game.Workspace.Part"], []);
    expect(block).toContain("Selected: game.Workspace.Part");
  });

  it("includes @mention summary", () => {
    const block = buildContextBlock(true, [], [{ path: "game.Workspace", summary: "5 children" }]);
    expect(block).toContain("@game.Workspace");
    expect(block).toContain("5 children");
  });

  it("includes connected status", () => {
    const block = buildContextBlock(true, [], []);
    expect(block).toContain("Connected: true");
  });

  it("starts with Live Studio Context header", () => {
    const block = buildContextBlock(false, [], []);
    expect(block).toContain("[Live Studio Context]");
  });

  it("includes both Selected and @mention together", () => {
    const block = buildContextBlock(true, ["game.Workspace.Part"], [{ path: "game.Workspace", summary: "5 children" }]);
    expect(block).toContain("Selected: game.Workspace.Part");
    expect(block).toContain("@game.Workspace: 5 children");
  });
});
