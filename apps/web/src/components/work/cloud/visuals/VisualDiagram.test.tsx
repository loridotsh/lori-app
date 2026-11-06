import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualDiagram } from "./VisualDiagram";
import { renderMermaid, type RenderedDiagram } from "./mermaidRenderer";
import type { DiagramBlock } from "@lori-enterprise/contracts";
vi.mock("./mermaidRenderer", () => ({ renderMermaid: vi.fn() }));
const graph: DiagramBlock = { type: "diagram", title: "Research flow", direction: "right", nodes: [{ id: "a", label: "Read sources" }, { id: "b", label: "Review" }], edges: [{ from: "a", to: "b", label: "Ready" }] };
const drawing: RenderedDiagram = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"/>', width: 400, height: 100 };
beforeEach(() => { vi.mocked(renderMermaid).mockReset(); vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Mermaid view lifecycle", () => {
  it("keeps the inline preview simple and withdraws the expanded viewer when inactive", async () => {
    vi.mocked(renderMermaid).mockResolvedValue(drawing);
    const view = render(<VisualDiagram block={graph} />);
    const open = await screen.findByRole("button", { name: "Expand Research flow" });
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    fireEvent.click(open);
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<VisualDiagram block={graph} active={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("closes an expanded graph immediately when its source changes", async () => {
    vi.mocked(renderMermaid).mockResolvedValue(drawing);
    const view = render(<VisualDiagram block={graph} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand Research flow" }));
    view.rerender(<VisualDiagram block={{ ...graph, direction: "down" }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
  });
  it("renders an inert image, preserves zoom through streaming clones, and releases its URL", async () => {
    vi.mocked(renderMermaid).mockResolvedValue(drawing);
    const view = render(<VisualDiagram block={graph} />);
    await waitFor(() => expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:diagram"));
    expect(view.container.querySelector('div[role="img"] svg')).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Research flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeTruthy();
    view.rerender(<VisualDiagram block={structuredClone(graph)} />);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(screen.getByText("125%")).toBeTruthy();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagram");
  });
  it("ignores stale renders after the graph changes", async () => {
    const resolve: ((value: RenderedDiagram) => void)[] = [];
    vi.mocked(renderMermaid).mockImplementation(() => new Promise(done => resolve.push(done)));
    const view = render(<VisualDiagram block={graph} />);
    view.rerender(<VisualDiagram block={{ ...graph, nodes: [{ id: "a", label: "Updated source" }, graph.nodes[1]!] }} />);
    expect(resolve).toHaveLength(2);
    await act(async () => resolve[0]!(drawing));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => resolve[1]!(drawing));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
  it("automatically presents complete connections when rendering fails", async () => {
    vi.mocked(renderMermaid).mockRejectedValue(new Error("Layout failed"));
    render(<VisualDiagram block={graph} />);
    await screen.findByText("The diagram could not be drawn. Its complete text is shown below.");
    expect(screen.getByText("Read sources → Review (Ready)")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Research flow" })).toBeTruthy();
  });
});
