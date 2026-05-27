import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelSelector } from "../ModelSelector";
import { useSettingsStore } from "@/stores/settings";
import { useModelsStore } from "@/stores/models";

describe("ModelSelector", () => {
  beforeEach(() => {
    useSettingsStore.setState({ selectedProvider: "openrouter", selectedModel: "openai/gpt-4o" });
    useModelsStore.setState({
      openrouterModels: [{
        id: "openai/gpt-4o",
        name: "GPT-4o",
        description: "Via server-configured OpenRouter",
        provider: "openrouter",
      }],
      isLoading: false,
      isLoadingClaude: false,
      isLoadingOpenRouter: false,
    });
  });

  it("renders a useful selected label and styled readable rows", () => {
    render(<ModelSelector serverProviders={{ anthropic: false, openrouter: true, codex: false }} />);

    const trigger = screen.getByRole("button", { name: /Current model: GPT-4o/ });
    expect(trigger.className).toContain("stud-model-trigger");
    fireEvent.click(trigger);

    const row = document.querySelector(".stud-model-row.is-selected") as HTMLButtonElement;
    expect(row).toBeTruthy();
    expect(row.className).toContain("stud-model-row");
    expect(row.getAttribute("data-selected")).toBe("true");
  });
});
