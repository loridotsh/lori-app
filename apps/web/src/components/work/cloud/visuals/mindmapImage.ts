import { MINDMAP_FONT, mindmapToggleOffset, mindmapToggleSize, type MindmapLayout } from "./mindmapLayout";

const palette = {
  background: "#ffffff",
  edge: "#b6b9c4",
  ink: "#1c1d22",
  muted: "#5d6170",
  fills: ["#fdebe2", "#f1f2f5", "#e8f5ee"],
  strokes: ["#f3b597", "#dcdee4", "#bfe3cf"],
  toggle: "#eceef3",
};

const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

export function mindmapSvg(layout: MindmapLayout, title: string): string {
  const edges = layout.edges.map(edge => `<path d="${edge.path}" fill="none" stroke="${palette.edge}" stroke-width="1.5"/>`).join("");
  const nodes = layout.nodes.map(node => {
    const tone = Math.min(node.depth, 2);
    const size = node.depth === 0 ? 14 : 13;
    const text = node.lines.map((line, index) => `<text x="${node.x + 15}" y="${node.y + 10 + 19 * index + 14}" font-size="${size}" font-weight="${node.depth === 0 ? 600 : 500}" fill="${palette.ink}">${escape(line)}</text>`).join("");
    const toggleX = node.x + node.width + mindmapToggleOffset;
    const toggleY = node.y + node.height / 2 - mindmapToggleSize / 2;
    const toggle = node.childCount ? `<rect x="${toggleX}" y="${toggleY}" width="${mindmapToggleSize}" height="${mindmapToggleSize}" rx="${mindmapToggleSize / 2}" fill="${palette.toggle}"/><text x="${toggleX + mindmapToggleSize / 2}" y="${toggleY + 15}" text-anchor="middle" font-size="${node.expanded ? 12 : 10}" font-weight="600" fill="${palette.muted}">${node.expanded ? "‹" : node.childCount}</text>` : "";
    return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${palette.fills[tone]}" stroke="${palette.strokes[tone]}"/>${text}${toggle}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family='${MINDMAP_FONT}'><title>${escape(title)}</title><rect width="100%" height="100%" fill="${palette.background}"/>${edges}${nodes}</svg>`;
}

export async function mindmapPng(layout: MindmapLayout, title: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([mindmapSvg(layout, title)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("image")); image.src = url; });
    const factor = Math.max(1, Math.min(scale, 8192 / layout.width, 8192 / layout.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(layout.width * factor);
    canvas.height = Math.round(layout.height * factor);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.scale(factor, factor);
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("png")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
