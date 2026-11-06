import type { DiagramBlock } from "@lori-enterprise/contracts";

// Only host-authored flowchart syntax reaches Mermaid. Labels cannot introduce
// statements, directives, HTML, links, or callbacks; node IDs are host-owned.
function label(value: string): string {
  return value.replace(/[&"#<>\[\]{}|`\\%\r\n;]/gu, character => `#${character.codePointAt(0)};`);
}
export function mermaidSource(block: DiagramBlock, direction = block.direction): string {
  const ids = new Map(block.nodes.map((node, index) => [node.id, `n${index}`]));
  return [`flowchart ${direction === "right" ? "LR" : "TD"}`,
    ...block.nodes.map(node => `  ${ids.get(node.id)}["${label(node.label)}"]`),
    ...block.edges.map(edge => {
      const from = ids.get(edge.from), to = ids.get(edge.to);
      if (!from || !to) throw new Error("A diagram connection has no matching node.");
      return edge.label ? `  ${from} -->|"${label(edge.label)}"| ${to}` : `  ${from} --> ${to}`;
    }),
  ].join("\n");
}
