import { describe, expect, it } from "vitest";
import { mermaidSource } from "./mermaidSource";
import { inspectMermaidSvg, renderMermaid } from "./mermaidRenderer";
import type { DiagramBlock } from "@lori-enterprise/contracts";
const graph: DiagramBlock = { type: "diagram", title: "Review", direction: "right", nodes: [{ id: "original", label: "Read sources" }, { id: "end", label: "Review" }], edges: [{ from: "original", to: "end", label: "Ready" }] };
describe("bounded Mermaid flowcharts", () => {
  it("uses standard flowchart syntax with host-owned IDs and preserves edges", () => {
    expect(mermaidSource(graph)).toBe('flowchart LR\n  n0["Read sources"]\n  n1["Review"]\n  n0 -->|"Ready"| n1');
    expect(mermaidSource(graph, "down")).toMatch(/^flowchart TD/);
    expect(graph.direction).toBe("right");
  });
  it("cannot turn hostile labels into directives, statements, HTML or links", () => {
    const label = '\"]\n%%{init: {securityLevel: "loose"}}%%\nclick n0 "javascript:alert(1)" <script>alert(1)</script> & #quot;';
    const source = mermaidSource({ ...graph, nodes: [{ id: "original", label }, graph.nodes[1]!], edges: [{ from: "original", to: "end", label }] });
    expect(source.split("\n")).toHaveLength(4);
    expect(source).not.toContain("%%{");
    expect(source).not.toContain("<script>");
    expect(source).toContain("#34;");
    expect(source).toContain("#10;");
    expect(source).toContain("#37;");
  });
  it("retains Unicode labels and rejects nonexistent connection endpoints", () => {
    expect(mermaidSource({ ...graph, nodes: [{ ...graph.nodes[0]!, label: "調査結果 😀" }, graph.nodes[1]!] })).toContain("調査結果 😀");
    expect(() => mermaidSource({ ...graph, edges: [{ from: "missing", to: "end" }] })).toThrow();
  });
  it("accepts only inert SVG output with finite dimensions and local style references", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>.x{clip-path:url(\"#clip\")}</style><text>url(https://example.com) is text</text></svg>';
    expect(inspectMermaidSvg(svg)).toMatchObject({ width: 100, height: 50 });
    for (const content of ['<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.com/x"/>', '<a href="javascript:alert(1)"/>', '<g onclick="alert(1)"/>', '<style>@import "https://example.com";</style>', '<style>.x{fill:url(https://example.com)}</style>']) {
      expect(() => inspectMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">${content}</svg>`)).toThrow();
    }
    expect(() => inspectMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 NaN 50"/>')).toThrow();
  });
  it("skips obsolete queued work before loading the renderer", async () => {
    await expect(renderMermaid("flowchart TD", () => false)).rejects.toThrow("superseded");
  });
});
