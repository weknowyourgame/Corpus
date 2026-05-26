import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scroll: vi.fn() }));

vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: Object.assign(
    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    { Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  ),
  useStickToBottomContext: () => ({ scrollToBottom: state.scroll }),
}));

import { ChatContainerFollow } from "../chat-container";

describe("ChatContainerFollow", () => {
  it("forces bottom only when a new user submission appears", () => {
    const view = render(<ChatContainerFollow submissionCount={1} />);
    expect(state.scroll).not.toHaveBeenCalled();

    view.rerender(<ChatContainerFollow submissionCount={1} />);
    expect(state.scroll).not.toHaveBeenCalled();

    view.rerender(<ChatContainerFollow submissionCount={2} />);
    expect(state.scroll).toHaveBeenCalledTimes(1);
  });
});
