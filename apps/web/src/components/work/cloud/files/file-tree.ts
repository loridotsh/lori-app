import type { CloudFile } from "@lori-enterprise/contracts";

export interface FolderRow {
  type: "folder";
  /** Full folder path, e.g. "reports/q3". */
  path: string;
  name: string;
  depth: number;
  /** Files anywhere below this folder that match the filter. */
  count: number;
  open: boolean;
}
export interface FileRow {
  type: "file";
  file: CloudFile;
  name: string;
  depth: number;
}
export type TreeRow = FolderRow | FileRow;

/** Where files the assistant moved aside live. It stays out of the way until opened. */
export const TRASH_FOLDER = "Trash";

interface Node {
  folders: Map<string, Node>;
  files: CloudFile[];
  count: number;
}
const node = (): Node => ({ folders: new Map(), files: [], count: 0 });
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The rows of the folder tree in display order: folders first, then files, each
 * sorted naturally ("file2" before "file10"), with Trash last. A filter shows
 * every match with its folders open; otherwise collapsed folders hide their rows.
 */
export function buildRows(
  files: CloudFile[],
  options: { query?: string; collapsed?: ReadonlySet<string> } = {},
): TreeRow[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const collapsed = options.collapsed ?? new Set<string>();
  const root = node();
  for (const file of files) {
    if (query && !file.path.toLowerCase().includes(query)) continue;
    const parts = file.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let current = root;
    current.count++;
    for (const part of parts.slice(0, -1)) {
      let next = current.folders.get(part);
      if (!next) current.folders.set(part, (next = node()));
      current = next;
      current.count++;
    }
    current.files.push(file);
  }
  const rows: TreeRow[] = [];
  const walk = (current: Node, prefix: string, depth: number) => {
    const folders = [...current.folders.keys()].sort((a, b) => {
      if (!prefix && (a === TRASH_FOLDER) !== (b === TRASH_FOLDER)) return a === TRASH_FOLDER ? 1 : -1;
      return collator.compare(a, b);
    });
    for (const name of folders) {
      const child = current.folders.get(name)!;
      const path = prefix ? `${prefix}/${name}` : name;
      const open = !!query || !collapsed.has(path);
      rows.push({ type: "folder", path, name, depth, count: child.count, open });
      if (open) walk(child, path, depth + 1);
    }
    const here = [...current.files].sort((a, b) =>
      collator.compare(a.path.split("/").at(-1) ?? a.path, b.path.split("/").at(-1) ?? b.path),
    );
    for (const file of here)
      rows.push({ type: "file", file, name: file.path.split("/").at(-1) ?? file.path, depth });
  };
  walk(root, "", 0);
  return rows;
}

/** Every folder that holds at least one file, so "collapse all" and defaults can name them. */
export function folderPaths(files: CloudFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean).slice(0, -1);
    parts.forEach((_, index) => found.add(parts.slice(0, index + 1).join("/")));
  }
  return [...found];
}

/** "Oct 12" for older files, the time for today's. Never throws on a bad date. */
export function formatModified(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      });
}
