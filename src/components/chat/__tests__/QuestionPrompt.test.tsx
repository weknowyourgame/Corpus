import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuestionPrompt } from "../QuestionPrompt";
import type { Question } from "@/stores/chat";

const toolboxQuestion: Question = {
  question: "Which Creator Store asset should I prepare for safe insertion?",
  type: "single",
  options: [
    {
      label: "Verified Tree",
      value: "111",
      imageUrl: "https://thumb/111.png",
      description: "Trusted Studio (verified) | 5000 upvotes",
    },
    {
      label: "Scripted Tree",
      value: "222",
      imageUrl: "https://thumb/222.png",
      description: "Indie Dev | 200 upvotes | contains scripts",
    },
    {
      label: "Broken Thumb",
      value: "333",
      imageUrl: "https://thumb/333.png",
      description: "Unknown | 1 upvote",
    },
    {
      label: "Load more results",
      value: "__load_more__",
      imageUrl: null,
      description: "Fetch the next 10 matches",
    },
    {
      label: "Search again with a different query",
      value: "__search_again__",
      imageUrl: null,
      description: "Pick a refined keyword and run a fresh search",
    },
  ],
};

describe("QuestionPrompt asset picker", () => {
  it("renders thumbnails, verified badge, scripts chip, and meta options with distinct icons", () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[toolboxQuestion]} onSubmit={onSubmit} />);

    expect(screen.getByText("Verified Tree")).toBeTruthy();
    expect(screen.getByText(/Trusted Studio \(verified\)/)).toBeTruthy();
    expect(screen.getByText(/contains scripts/)).toBeTruthy();
    expect(screen.getByText("Load more results")).toBeTruthy();
    expect(screen.getByText("Search again with a different query")).toBeTruthy();

    const scriptedCard = screen.getByTestId("asset-222");
    expect(scriptedCard.querySelector("[title='Asset contains scripts']")).toBeTruthy();

    const loadMore = screen.getByTestId("meta-__load_more__");
    expect(loadMore).toBeTruthy();
    const searchAgain = screen.getByTestId("meta-__search_again__");
    expect(searchAgain).toBeTruthy();
  });

  it("submits the asset value when picked", () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[toolboxQuestion]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("asset-111"));
    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));
    expect(onSubmit).toHaveBeenCalledWith(["111"]);
  });

  it("submits the load-more sentinel when the user wants paginated results", () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[toolboxQuestion]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("meta-__load_more__"));
    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));
    expect(onSubmit).toHaveBeenCalledWith(["__load_more__"]);
  });

  it("shows a No preview fallback when the thumbnail fails to load", () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[toolboxQuestion]} onSubmit={onSubmit} />);
    const card = screen.getByTestId("asset-333");
    const image = card.querySelector("img");
    expect(image).toBeTruthy();
    fireEvent.error(image as HTMLImageElement);
    expect(card.textContent ?? "").toContain("No preview");
  });
});
