import type { MindmapBlock } from "@lori-enterprise/contracts";

export const MINDMAP_FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const PAD_X = 14;
const PAD_Y = 9;
const LINE = 19;
const TOGGLE = 22;
const TOGGLE_GAP = 6;
const GAP_X = 56;
const GAP_Y = 10;
const GROUP_GAP = 22;
export const MINDMAP_MARGIN = 28;

export interface PlacedNode {
  id: string;
  label: string;
  detail?: string;
  depth: number;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  childCount: number;
  expanded: boolean;
}
export interface PlacedEdge { from: string; to: string; path: string; depth: number }
export interface MindmapLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

type Measure = (text: string, depth: number) => number;

let context: CanvasRenderingContext2D | null | undefined;
function canvasMeasure(text: string, depth: number): number | null {
  if (context === undefined) {
    try { context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d"); }
    catch { context = null; }
  }
  if (!context) return null;
  context.font = `${depth === 0 ? 600 : 500} ${depth === 0 ? 14 : 13}px ${MINDMAP_FONT}`;
  const width = context.measureText(text).width;
  return Number.isFinite(width) && width > 0 ? width : null;
}

export const measureText: Measure = (text, depth) => canvasMeasure(text, depth) ?? text.length * (depth === 0 ? 8 : 7.4);

export function wrapLabel(label: string, maxWidth: number, depth: number, measure: Measure = measureText): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, depth) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    if (measure(word, depth) <= maxWidth) { line = word; continue; }
    let piece = "";
    for (const character of word) {
      if (measure(piece + character, depth) > maxWidth && piece) { lines.push(piece); piece = ""; }
      piece += character;
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [label];
}

export function mindmapChildren(block: MindmapBlock): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of block.nodes) {
    if (node.parentId === undefined) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  return children;
}

export function mindmapRoot(block: MindmapBlock) {
  return block.nodes.find(node => node.parentId === undefined)!;
}

export function initialCollapsed(block: MindmapBlock): Set<string> {
  const children = mindmapChildren(block);
  if (block.nodes.length <= 14) return new Set();
  const root = mindmapRoot(block);
  return new Set(block.nodes.filter(node => node.id !== root.id && children.has(node.id)).map(node => node.id));
}

export function layoutMindmap(block: MindmapBlock, collapsed: ReadonlySet<string>, measure: Measure = measureText): MindmapLayout {
  const byId = new Map(block.nodes.map(node => [node.id, node]));
  const children = mindmapChildren(block);
  const root = mindmapRoot(block);
  const visible: { id: string; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    visible.push({ id, depth });
    if (!collapsed.has(id)) for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };
  walk(root.id, 0);

  const sized = new Map<string, Omit<PlacedNode, "x" | "y">>();
  const columns: number[] = [];
  for (const { id, depth } of visible) {
    const node = byId.get(id)!;
    const lines = wrapLabel(node.label, depth === 0 ? 220 : 196, depth, measure);
    const width = Math.ceil(Math.max(...lines.map(line => measure(line, depth)))) + PAD_X * 2 + 2;
    const height = lines.length * LINE + PAD_Y * 2 + 2;
    const childCount = children.get(id)?.length ?? 0;
    sized.set(id, { id, label: node.label, detail: node.detail, depth, lines, width, height, childCount, expanded: childCount > 0 && !collapsed.has(id) });
    columns[depth] = Math.max(columns[depth] ?? 0, width + (childCount ? TOGGLE + TOGGLE_GAP : 0));
  }
  const columnX: number[] = [];
  columns.forEach((_, depth) => { columnX[depth] = depth === 0 ? MINDMAP_MARGIN : columnX[depth - 1]! + columns[depth - 1]! + GAP_X; });

  const placed = new Map<string, PlacedNode>();
  const place = (id: string, top: number): number => {
    const node = sized.get(id)!;
    const kids = node.expanded ? children.get(id)! : [];
    if (!kids.length) {
      placed.set(id, { ...node, x: columnX[node.depth]!, y: top });
      return node.height;
    }
    let cursor = top;
    kids.forEach((child, index) => {
      if (index) cursor += node.depth === 0 ? GROUP_GAP : GAP_Y;
      cursor += place(child, cursor);
    });
    const first = placed.get(kids[0]!)!;
    const last = placed.get(kids.at(-1)!)!;
    const center = (first.y + first.height / 2 + last.y + last.height / 2) / 2;
    let y = center - node.height / 2;
    let shift = 0;
    if (y < top) { shift = top - y; y = top; }
    if (shift) {
      const move = (childId: string) => {
        const item = placed.get(childId)!;
        placed.set(childId, { ...item, y: item.y + shift });
        if (item.expanded) for (const grandchild of children.get(childId)!) move(grandchild);
      };
      kids.forEach(move);
    }
    placed.set(id, { ...node, x: columnX[node.depth]!, y });
    return Math.max(cursor - top + shift, y + node.height - top);
  };
  const height = place(root.id, MINDMAP_MARGIN);

  const edges: PlacedEdge[] = [];
  for (const node of placed.values()) {
    if (!node.expanded) continue;
    const startX = node.x + node.width + TOGGLE_GAP + TOGGLE;
    const startY = node.y + node.height / 2;
    for (const childId of children.get(node.id)!) {
      const child = placed.get(childId)!;
      const endY = child.y + child.height / 2;
      const middle = (startX + child.x) / 2;
      edges.push({ from: node.id, to: childId, depth: node.depth, path: `M${startX},${startY} C${middle},${startY} ${middle},${endY} ${child.x},${endY}` });
    }
  }
  const nodes = visible.map(({ id }) => placed.get(id)!);
  const width = Math.max(...nodes.map(node => node.x + node.width + (node.childCount ? TOGGLE_GAP + TOGGLE : 0))) + MINDMAP_MARGIN;
  return { nodes, edges, width, height: height + MINDMAP_MARGIN * 2 };
}

export const mindmapToggleOffset = TOGGLE_GAP;
export const mindmapToggleSize = TOGGLE;
