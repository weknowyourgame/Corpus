import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextChips } from "../ContextChips";
import { RunContextNotice } from "../RunContextNotice";

describe("ContextChips", () => {
  it("shows only supported actions and reports activation", () => {
    const onClick = vi.fn();
    render(<ContextChips onChipClick={onClick} activeChips={["plan"]} />);

    expect(screen.queryByRole("button", { name: "Web" })).toBeNull();
    expect(screen.getByRole("button", { name: "Toolbox" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Toolbox" }));
    expect(onClick).toHaveBeenCalledWith("toolbox");
  });

  it("explains read-only and high-risk modes before submission", () => {
    render(<RunContextNotice active={["plan", "run-code"]} />);

    expect(screen.getByText("Plan mode is on")).toBeTruthy();
    expect(screen.getByText(/Studio changes and code execution are blocked/)).toBeTruthy();
    expect(screen.getByText(/requires an approval card/)).toBeTruthy();
  });
});
