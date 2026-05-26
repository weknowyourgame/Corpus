import { describe, expect, it } from "vitest";
import { compatibleServerSelection } from "../model-routing";

describe("compatibleServerSelection", () => {
  it("preserves the selected provider and model when configured", () => {
    expect(compatibleServerSelection("openrouter", "openai/gpt-4o-mini", {
      anthropic: true,
      openrouter: true,
      codex: false,
    })).toEqual({ provider: "openrouter", model: "openai/gpt-4o-mini" });
  });

  it("routes a selected GPT model through OpenRouter without changing its model family", () => {
    expect(compatibleServerSelection("codex", "gpt-4o", {
      anthropic: true,
      openrouter: true,
      codex: false,
    })).toEqual({ provider: "openrouter", model: "openai/gpt-4o" });
  });

  it("does not silently replace an unavailable selected model with Claude", () => {
    expect(compatibleServerSelection("codex", "gpt-4o", {
      anthropic: true,
      openrouter: false,
      codex: false,
    })).toBeNull();
  });
});
