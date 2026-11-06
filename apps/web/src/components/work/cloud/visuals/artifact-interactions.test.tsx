import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../../../packages/contracts/fixtures/artifact-fixture.json";
import studio from "../../../../../../../packages/contracts/fixtures/studio-fixture.json";
import { VisualDocument } from "./visual-activity";
import { parseVisual, type CloudVisual } from "@lori-enterprise/contracts";
import { exportVisual } from "./exportVisual";

vi.mock("./mermaidRenderer", () => ({ renderMermaid: vi.fn().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"></svg>', width: 400, height: 120 }) }));
vi.mock("./exportVisual", () => ({ exportVisual: vi.fn().mockResolvedValue(true), exportImage: vi.fn().mockResolvedValue(true) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const visual = parseVisual(fixture)!;
const deck = parseVisual(studio)!;
const only = (block: CloudVisual["blocks"][number]): CloudVisual => ({ ...visual, title: block.title, blocks: [block] });

describe("interactive artifacts", () => {
  it("provides graph zoom and a complete text alternative for diagrams", async () => {
    render(<VisualDocument visual={only(visual.blocks[0]!)} />);
    expect(screen.getByRole("img", { name: /A grounded research workflow/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View connections" }));
    expect(screen.getByText("Review findings → Find connections (Refine)")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Expand A grounded research workflow" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    expect(within(dialog).getByText("125%")).toBeTruthy();
  });

  it("lays out the mind map as a navigable canvas with collapsible branches and topic details", () => {
    render(<VisualDocument visual={visual} />);
    const map = screen.getByRole("application", { name: /What makes research useful\?/ });
    expect(within(map).getByRole("button", { name: "Read original sources" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(within(map).queryByRole("button", { name: "Read original sources" })).toBeNull();
    expect(within(map).getByRole("button", { name: "Evidence" })).toBeTruthy();
    expect(within(map).getByRole("button", { name: "Expand Evidence (1 subtopic)" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(within(map).getByRole("button", { name: "Read original sources" })).toBeTruthy();
    fireEvent.click(within(map).getByRole("button", { name: "Collapse Evidence (1 subtopic)" }));
    expect(within(map).queryByRole("button", { name: "Read original sources" })).toBeNull();
    fireEvent.click(within(map).getByRole("button", { name: "Expand Evidence (1 subtopic)" }));
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
    fireEvent.click(within(map).getByRole("button", { name: "Synthesis" }));
    expect(screen.getByRole("region", { name: "About Synthesis" }).textContent).toContain("Explain how the evidence relates to the question.");
    fireEvent.click(screen.getByRole("button", { name: "Close topic details" }));
    expect(screen.queryByRole("region", { name: "About Synthesis" })).toBeNull();
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("120%")).toBeTruthy();
    fireEvent.keyDown(map, { key: "0" });
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByRole("list", { name: "A research sprint" })).toBeTruthy();
  });

  it("reveals answers on selection, scores locally, preserves practice across rerenders and retries missed questions", () => {
    const { rerender } = render(<VisualDocument visual={visual} />);
    expect(screen.getByText("Choose an answer to check it")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /An untested assumption/ }));
    expect(screen.getByText("Correct answer: An original source")).toBeTruthy();
    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /An original source/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /An original source/ }));
    rerender(<VisualDocument visual={structuredClone(visual)} />);
    expect(screen.getByText("0 of 1 correct")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next question in Check your understanding" }));
    fireEvent.click(screen.getByRole("radio", { name: /When new evidence changes it/ }));
    expect(screen.getByText("That’s right!")).toBeTruthy();
    expect(screen.getByText("1 of 2 correct")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /See results/ }));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry 1 missed/ }));
    expect(screen.getByText("1 / 1")).toBeTruthy();
    expect(screen.getByText("What should support a research conclusion?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart quiz" }));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("Choose an answer to check it")).toBeTruthy();
  });

  it("includes skipped questions in results and retries only those questions", () => {
    render(<VisualDocument visual={visual} />);
    fireEvent.click(screen.getByRole("radio", { name: /An original source/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next question in Check your understanding" }));
    fireEvent.click(screen.getByRole("button", { name: /See results/ }));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText(/1 to review/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry 1 missed/ }));
    expect(screen.getByText("1 / 1")).toBeTruthy();
    expect(screen.queryByText("What should support a research conclusion?")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /When new evidence changes it/ }));
    fireEvent.click(screen.getByRole("button", { name: /See results/ }));
    expect(screen.getByText("Every answer correct. Nicely done.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry .* missed/ })).toBeNull();
  });

  it.each(["inline", "stage"] as const)("gates mind-map image export in %s and expanded views", layout => {
    const mindmap = visual.blocks.find(block => block.type === "mindmap")!;
    const { rerender } = render(<VisualDocument visual={only(mindmap)} layout={layout} canExport />);
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
    rerender(<VisualDocument visual={only(mindmap)} layout={layout} canExport={false} />);
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    if (layout === "inline") {
      fireEvent.click(screen.getByRole("button", { name: `Open ${mindmap.title} in a larger view` }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByRole("button", { name: "Download image" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Zoom in" })).toBeTruthy();
    }
  });

  it("shows hints before answering and per-option rationales after", () => {
    render(<VisualDocument visual={only(deck.blocks[2]!)} />);
    fireEvent.click(screen.getByRole("button", { name: "Hint" }));
    expect(screen.getByRole("note").textContent).toBe("It improved during the quarter.");
    fireEvent.keyDown(screen.getByRole("radio", { name: /3\.4%/ }), { key: "b" });
    expect(screen.getByText("Churn fell to 2.1% by September.")).toBeTruthy();
    expect(screen.getByText("This was churn before the onboarding changes.")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("flips flashcards, tracks got-it and missed cards, and reviews only the missed ones", () => {
    render(<VisualDocument visual={visual} />);
    const card = screen.getByRole("button", { name: /Show answer$/ });
    expect(card.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(card);
    expect(screen.getByRole("button", { name: /^Answer: Original material/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.getByText("Card 2 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Question: What is an assumption\?/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Missed it" }));
    expect(screen.getByText("1 of 2 known")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review 1 missed/ }));
    expect(screen.getByText("Card 1 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Question: What is an assumption\?/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart cards" }));
    expect(screen.getByText("Card 1 of 2")).toBeTruthy();
  });

  it("navigates, previews and presents slide decks", () => {
    render(<VisualDocument visual={only(deck.blocks[0]!)} />);
    expect(screen.getByRole("group", { name: "Slide 1 of 7: Growth held while costs fell" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByRole("group", { name: "Slide 2 of 7: Revenue up, churn down" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Slide 3: Revenue grew every month" }));
    const stage = screen.getByRole("group", { name: "Slide 3 of 7: Revenue grew every month" });
    expect(within(stage).getByRole("img", { name: /Bar chart in \$M: Revenue Jul 1\.2, Aug 1\.4, Sep 1\.6/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("region", { name: "Speaker notes" }).textContent).toBe("No notes for this slide.");
    fireEvent.click(screen.getByRole("button", { name: "Slide 1: Growth held while costs fell" }));
    expect(screen.getByRole("region", { name: "Speaker notes" }).textContent).toContain("Open with the headline");
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    const presenter = screen.getByRole("dialog", { name: "Presenting Q3 in review" });
    fireEvent.keyDown(presenter, { key: "End" });
    expect(within(presenter).getAllByText("7 / 7")).toHaveLength(2);
    fireEvent.keyDown(presenter, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Presenting Q3 in review" })).toBeNull();
    expect(screen.getByRole("group", { name: "Slide 7 of 7: Questions and discussion" })).toBeTruthy();
  });

  it("renders reports as readable sections with formatted text and no markup", () => {
    render(<VisualDocument visual={only(deck.blocks[1]!)} />);
    expect(screen.getByRole("heading", { name: "Executive summary" })).toBeTruthy();
    expect(screen.getByText("$4.2M").tagName).toBe("STRONG");
    const lists = within(screen.getByRole("article")).getAllByRole("list");
    expect(lists.map(list => list.tagName)).toEqual(["UL", "OL"]);
    expect(within(lists[1]!).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Confirm the Q4 hiring plan", "Review pricing in November"]);
  });

  it("keeps immersive artifacts focused in the stage layout with a summary disclosure", () => {
    render(<VisualDocument visual={only(visual.blocks[4]!)} layout="stage" expandable={false} />);
    const disclosure = screen.getByRole("button", { name: /Summary and 1 source/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Sources" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /in a larger view$/ })).toBeNull();
    expect(screen.getByText("Flashcards")).toBeTruthy();
  });

  it("expands an inline artifact into a larger view", () => {
    render(<VisualDocument visual={only(deck.blocks[0]!)} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Q3 in review in a larger view" }));
    const dialog = screen.getByRole("dialog", { name: "Q3 in review" });
    expect(within(dialog).getByRole("group", { name: "Slide 1 of 7: Growth held while costs fell" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog", { name: "Q3 in review" })).toBeNull();
  });

  it("exports only the immutable source snapshot and honors the export capability", async () => {
    const { rerender } = render(<VisualDocument visual={visual} />);
    fireEvent.click(screen.getByRole("button", { name: "Download visual data" }));
    await waitFor(() => expect(exportVisual).toHaveBeenCalledWith(visual));
    const sources = screen.getByRole("button", { name: `${visual.sources!.length} ${visual.sources!.length === 1 ? "source" : "sources"}` });
    expect(sources.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sources);
    expect(sources.getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Sources" })).getAllByRole("listitem")).toHaveLength(visual.sources!.length);
    rerender(<VisualDocument visual={visual} canExport={false} />);
    expect(screen.queryByRole("button", { name: "Download visual data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  });
});
