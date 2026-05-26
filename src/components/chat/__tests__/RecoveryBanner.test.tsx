import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalPrompt } from "../ApprovalPrompt";
import { RecoveryBanner } from "../RecoveryBanner";

describe("chat recovery and approval surfaces", () => {
  it("gives exact server-side provider setup recovery", () => {
    render(<RecoveryBanner error="No server AI provider credential configured." />);

    expect(screen.getByText(/AI provider is not configured on the server/)).toBeTruthy();
    expect(screen.getByText(/OPENROUTER_API_KEY/)).toBeTruthy();
    expect(screen.getByText(/restart npm run dev/)).toBeTruthy();
  });

  it("keeps high-risk approval readable and actionable", () => {
    render(
      <ApprovalPrompt
        approval={{
          approvalId: "approval-1",
          toolCallId: "tool-1",
          toolName: "mcp__roblox_studio__execute_luau",
          summary: "Execute Luau in Studio",
          scope: "studio:code",
          risk: "runtime_code",
        }}
        onDecision={() => undefined}
      />,
    );

    expect(screen.getByText(/Approval required: runtime code/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
