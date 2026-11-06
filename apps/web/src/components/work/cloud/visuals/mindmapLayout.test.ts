import { describe, expect, it } from "vitest";
import type { MindmapBlock } from "@lori-enterprise/contracts";
import { initialCollapsed, layoutMindmap, wrapLabel } from "./mindmapLayout";
import { mindmapSvg } from "./mindmapImage";
import { reportParts, emphasis } from "./reportText";

const measure = (text: string) => text.length * 7;
const block: MindmapBlock = {
  type: "mindmap",
  title: "Plan",
  nodes: [
    { id: "root", label: "Company plan" },
    ...["a", "b", "c"].map(id => ({ id, parentId: "root", label: `Branch ${id}` })),
    ...["a", "b", "c"].flatMap(parent => [1, 2, 3, 4].map(n => ({ id: `${parent}${n}`, parentId: parent, label: `Leaf ${parent}${n} with a longer descriptive label` }))),
  ],
};

describe("mind map layout", () => {
  it("wraps long labels within the column width and splits unbreakable words", () => {
    expect(wrapLabel("Alpha beta gamma delta", 80, 1, measure)).toEqual(["Alpha beta", "gamma delta"]);
    expect(wrapLabel("Supercalifragilistic", 70, 1, measure)).toEqual(["Supercalif", "ragilistic"]);
  });

  it("shows the root and first level for large maps", () => {
    const collapsed = initialCollapsed(block);
    expect([...collapsed].sort()).toEqual(["a", "b", "c"]);
    const layout = layoutMindmap(block, collapsed, measure);
    expect(layout.nodes.map(node => node.id)).toEqual(["root", "a", "b", "c"]);
    expect(layout.nodes.find(node => node.id === "a")).toMatchObject({ childCount: 4, expanded: false });
  });

  it("places columns left to right, centers parents on their children, and never overlaps siblings", () => {
    const layout = layoutMindmap(block, new Set(), measure);
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    const root = byId.get("root")!;
    const branch = byId.get("a")!;
    const leaves = ["a1", "a2", "a3", "a4"].map(id => byId.get(id)!);
    expect(branch.x).toBeGreaterThan(root.x + root.width);
    expect(leaves[0]!.x).toBeGreaterThan(branch.x + branch.width);
    const center = (leaves[0]!.y + leaves[0]!.height / 2 + leaves[3]!.y + leaves[3]!.height / 2) / 2;
    expect(Math.abs(branch.y + branch.height / 2 - center)).toBeLessThan(0.01);
    const column = layout.nodes.filter(node => node.depth === 2).sort((a, b) => a.y - b.y);
    column.slice(1).forEach((node, index) => expect(node.y).toBeGreaterThanOrEqual(column[index]!.y + column[index]!.height));
    expect(layout.edges).toHaveLength(15);
    expect(layout.width).toBeGreaterThan(leaves[0]!.x + leaves[0]!.width);
    expect(layout.height).toBeGreaterThan(Math.max(...layout.nodes.map(node => node.y + node.height)));
  });

  it("exports an inert standalone SVG with escaped labels", () => {
    const svg = mindmapSvg(layoutMindmap({ ...block, nodes: [{ id: "root", label: "<script>alert(1)</script> & co" }] }, new Set(), measure), "A & B");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;script&#62;");
    expect(svg).toContain("<title>A &#38; B</title>");
  });
});

describe("report text", () => {
  it("splits paragraphs, bullets and numbered steps without interpreting markup", () => {
    expect(reportParts("First line\nsecond line\n\n- one\n- two\n\n3. three\n4. four\nAfter <b>x</b>")).toEqual([
      { kind: "paragraph", lines: ["First line", "second line"] },
      { kind: "bullets", items: ["one", "two"] },
      { kind: "numbered", items: ["three", "four"], start: 3 },
      { kind: "paragraph", lines: ["After <b>x</b>"] },
    ]);
    expect(emphasis("Revenue **grew** fast")).toEqual([{ text: "Revenue ", strong: false }, { text: "grew", strong: true }, { text: " fast", strong: false }]);
  });
});
