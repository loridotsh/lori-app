import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudMarkdown, cloudLink } from "./cloud-markdown";

afterEach(cleanup);
describe("Cloud Work code blocks", () => {
  it("labels the language and copies the code without the trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <CloudMarkdown text={"Run:\n\n```sh\ndocker compose up\n```\n\nThen `check` it."} />,
    );
    expect(screen.getByText("sh")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docker compose up"));
    expect(await screen.findByRole("button", { name: "Code copied" })).toBeTruthy();
    // Inline code is styled by the container, not given a code-block chrome.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    vi.unstubAllGlobals();
  });
  it("falls back to a text label and survives a blocked clipboard", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<CloudMarkdown text={"```\nplain\n```"} />);
    expect(screen.getByText("text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy());
    vi.unstubAllGlobals();
  });
  it("updates growing response text without adding a cursor or animation", () => {
    const { container, rerender } = render(<CloudMarkdown text="Hello" />);
    expect(screen.getByText("Hello")).toBeTruthy();
    rerender(<CloudMarkdown text="Hello **world**" />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(container.firstElementChild?.className).not.toMatch(/after:|animate-/);
  });
});
describe("Cloud Work model Markdown", () => {
  it("shows artifact titles and a workspace navigation cue without changing file resolution", () => {
    const onOpenFile = vi.fn();
    render(<CloudMarkdown text="Created [`cash runway.lori.json`](./cash%20runway.lori.json). [Review calculator](cash%20runway.lori.json). [Missing](missing.lori.json)."
      existingPaths={new Set(["cash runway.lori.json"])} onOpenFile={onOpenFile}
      artifactTitles={new Map([["cash runway.lori.json", "Cash Runway Calculator"]])} />);
    const link = screen.getByRole("button", { name: "Open Cash Runway Calculator in workspace" });
    expect(link.textContent).toBe("Cash Runway Calculator");
    expect(link.title).toContain("Open in workspace");
    expect(link.title).toContain("cash runway.lori.json");
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("cash runway.lori.json");
    expect(screen.getByRole("button", { name: "Open Review calculator in workspace" }).textContent).toBe("Review calculator");
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("opens only exact relative conversation-file links in the preview", () => {
    const onOpenFile = vi.fn();
    render(<CloudMarkdown
      text="[Preview report](./reports/my%20plan.md) [Missing](missing.md) [API](/api/private) [Unsafe](javascript:alert)"
      existingPaths={new Set(["reports/my plan.md"])} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview report" }));
    expect(onOpenFile).toHaveBeenCalledWith("reports/my plan.md");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("renders structured text without remote tracking images or raw HTML", () => {
    const { container } = render(
      <CloudMarkdown
        text={
          '## Plan\n\n**Review** the changes.\n\n- First\n- Second\n\n![tracking](https://tracker.test/pixel)\n\n<script>alert(1)</script>\n\n<iframe src="https://tracker.test"></iframe>'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getByText("Review").tagName).toBe("STRONG");
    expect(container.querySelector("img,script,iframe")).toBeNull();
  });
  it("allows only explicit web links and opens them without opener or referrer", () => {
    render(
      <CloudMarkdown
        text={
          "[Source](https://example.test/docs) [Unsafe](javascript:alert) [Relative](/admin)"
        }
      />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const link = screen.getByRole("link", { name: "Source" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(cloudLink("data:text/html,hello")).toBeUndefined();
    expect(cloudLink("//tracker.test")).toBeUndefined();
    expect(cloudLink("file:///secret")).toBeUndefined();
  });
});
