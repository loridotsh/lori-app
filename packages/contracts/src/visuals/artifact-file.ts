import { parseVisual } from "./validate.js";
import type { CloudVisual } from "./types.js";

/** Whitespace is bounded too, before parsing. The canonical visual remains <=48 KiB. */
export const MAX_ARTIFACT_FILE_BYTES = 96 * 1024;
export const isArtifactFile = (path: string) => /\.lori\.json$/i.test(path);

/** Saved artifacts use exactly the inline catalog, never executable document content. */
export function parseArtifactFile(text: string) {
  if (text.length > MAX_ARTIFACT_FILE_BYTES || new TextEncoder().encode(text).length > MAX_ARTIFACT_FILE_BYTES) return null;
  try { return parseVisual(JSON.parse(text.replace(/^\uFEFF/, ""))); }
  catch { return null; }
}

/** Display copy only. The original path and file identity remain the navigation target. */
export function artifactDisplayName(path: string, title?: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  if (!isArtifactFile(path)) return name;
  if (title?.trim()) return title.trim();
  const words = name.replace(/\.lori\.json$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : "Untitled artifact";
}

export function artifactLinkText(path: string, text: string, title?: string): string | null {
  const name = path.split("/").at(-1);
  return isArtifactFile(path) && [path, name, `./${path}`].includes(text.trim()) ? artifactDisplayName(path, title) : null;
}

/** Recover titles from successful complete writes; partial edits discard stale titles. No file reads or history changes. */
export function artifactVisualsFromTools(tools: readonly { name: string; status: string; arguments: Record<string, unknown> }[]): ReadonlyMap<string, CloudVisual> {
  const visuals = new Map<string, CloudVisual>();
  for (const tool of tools) {
    if (tool.status !== "completed" || !["write_file", "edit_file"].includes(tool.name) || typeof tool.arguments.path !== "string" || !isArtifactFile(tool.arguments.path)) continue;
    const path = tool.arguments.path.replace(/^\.\//, "");
    visuals.delete(path);
    const content = tool.name === "write_file" ? tool.arguments.content : tool.arguments.newText;
    const visual = typeof content === "string" ? parseArtifactFile(content) : null;
    if (visual) visuals.set(path, visual);
  }
  return visuals;
}

export function artifactTitlesFromTools(tools: readonly { name: string; status: string; arguments: Record<string, unknown> }[]): ReadonlyMap<string, string> {
  return new Map([...artifactVisualsFromTools(tools)].map(([path, visual]) => [path, visual.title]));
}
