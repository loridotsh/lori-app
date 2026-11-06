import { afterEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { renderMermaid } from "./mermaidRenderer";
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
describe("standard Mermaid rendering", () => {
  it("uses the default theme without custom typography, palette, spacing, curves or layout", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"/>', diagramType: "flowchart" });
    await renderMermaid('flowchart LR\n  n0["Source"]', () => true);
    const config = vi.mocked(mermaid.initialize).mock.calls[0]![0]!;
    expect(config.theme).toBe("default");
    for (const key of ["themeVariables", "themeCSS", "fontFamily", "flowchart", "look", "layout"]) expect(config).not.toHaveProperty(key);
    expect(config.securityLevel).toBe("strict");
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
  it("cleans up the temporary render host after a rendering failure", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("Rendering failed"));
    await expect(renderMermaid("flowchart TD", () => true)).rejects.toThrow("Rendering failed");
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
