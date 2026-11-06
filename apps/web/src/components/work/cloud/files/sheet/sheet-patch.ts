/**
 * Splices changed cells into a worksheet's XML text. Everything it is not asked to change is
 * copied through byte for byte, so formatting, conditional rules, charts' anchors, protection
 * and extension data survive an edit exactly as the original application wrote them.
 */
import { MAX_COLS } from "./address";
import { escapeAttribute, scan, XmlSyntaxError } from "./sax";

/** Row -> column -> replacement `<c>` XML, or null to remove the cell. */
export type CellPatches = Map<number, Map<number, string | null>>;

const sortedColumns = (row: Map<number, string | null> | undefined, exclude: Set<number>): number[] =>
  row ? [...row.keys()].filter((col) => !exclude.has(col) && row.get(col) !== null).sort((a, b) => a - b) : [];

export function patchSheet(xml: string, patches: CellPatches, dimension: string | null): string {
  const out: string[] = [];
  let cursor = 0;
  const copyTo = (position: number) => {
    if (position > cursor) out.push(xml.slice(cursor, position));
    cursor = Math.max(cursor, position);
  };
  const replace = (start: number, end: number, text: string) => {
    copyTo(start);
    out.push(text);
    cursor = end;
  };
  const insert = (position: number, text: string) => replace(position, position, text);

  const pendingRows = [...patches.keys()].sort((a, b) => a - b);
  const rowXml = (row: number): string => {
    const cells = patches.get(row)!;
    const cols = sortedColumns(cells, new Set());
    return cols.length ? `<row r="${row + 1}">${cols.map((col) => cells.get(col)!).join("")}</row>` : "";
  };
  const flushRows = (before: number, position: number) => {
    while (pendingRows.length && pendingRows[0]! < before) {
      const row = pendingRows.shift()!;
      const text = rowXml(row);
      if (text) insert(position, text);
    }
  };

  const path: string[] = [];
  let row = -1;
  let nextRow = 0;
  let nextCol = 0;
  let rowPatches: Map<number, string | null> | undefined;
  let seenCols = new Set<number>();
  let pendingCols: number[] = [];
  let replacingCell: { start: number; xml: string } | null = null;

  const takeColumnsBefore = (col: number, position: number) => {
    while (pendingCols.length && pendingCols[0]! < col) {
      const next = pendingCols.shift()!;
      insert(position, rowPatches!.get(next)!);
    }
  };

  for (const token of scan(xml)) {
    if (token.kind === "text") continue;
    if (token.kind === "close") {
      const open = path.pop();
      if (open !== token.name) throw new XmlSyntaxError("Mismatched tags");
      if (token.name === "c" && replacingCell) {
        replace(replacingCell.start, token.end, replacingCell.xml);
        replacingCell = null;
      } else if (token.name === "row") {
        if (rowPatches) takeColumnsBefore(MAX_COLS + 1, token.start);
        rowPatches = undefined;
      } else if (token.name === "sheetData") {
        flushRows(Infinity, token.start);
      }
      continue;
    }
    switch (token.name) {
      case "dimension":
        if (dimension && token.attrs.ref !== undefined) {
          replace(token.start, token.end, xml.slice(token.start, token.end).replace(/ref\s*=\s*(?:"[^"]*"|'[^']*')/, `ref="${escapeAttribute(dimension)}"`));
        }
        break;
      case "sheetData":
        if (token.kind === "self") {
          const rows = pendingRows.splice(0).map(rowXml).join("");
          replace(token.start, token.end, rows ? `<sheetData>${rows}</sheetData>` : xml.slice(token.start, token.end));
        }
        break;
      case "row": {
        const declared = Number(token.attrs.r);
        row = Number.isInteger(declared) && declared >= 1 ? declared - 1 : nextRow;
        nextRow = row + 1;
        nextCol = 0;
        // Rows that did not exist yet go in before the first row that sorts after them.
        flushRows(row, token.start);
        if (pendingRows[0] === row) pendingRows.shift();
        rowPatches = patches.get(row);
        seenCols = new Set();
        pendingCols = [];
        if (rowPatches) {
          const raw = xml.slice(token.start, token.end);
          // Cached spans no longer describe the row once cells are added or removed.
          const tag = raw.replace(/\s+spans\s*=\s*(?:"[^"]*"|'[^']*')/, "");
          if (token.kind === "self") {
            const cols = sortedColumns(rowPatches, new Set());
            replace(token.start, token.end, `${tag.replace(/\s*\/>$/, ">")}${cols.map((col) => rowPatches!.get(col)!).join("")}</row>`);
            rowPatches = undefined;
          } else {
            if (tag !== raw) replace(token.start, token.end, tag);
            // Which of this row's patched columns have no cell in the file yet is learned as cells are read.
            pendingCols = [...rowPatches.keys()].filter((col) => rowPatches!.get(col) !== null).sort((a, b) => a - b);
          }
        }
        break;
      }
      case "c": {
        const ref = token.attrs.r;
        const match = ref ? /^[A-Za-z]+/.exec(ref) : null;
        let col = nextCol;
        if (match) {
          col = 0;
          for (const ch of match[0].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
          col -= 1;
        }
        nextCol = col + 1;
        if (!rowPatches) break;
        seenCols.add(col);
        // New cells that sort before this one are inserted ahead of it.
        const ahead = pendingCols.filter((pending) => pending < col);
        pendingCols = pendingCols.filter((pending) => pending >= col);
        for (const pending of ahead) insert(token.start, rowPatches.get(pending)!);
        pendingCols = pendingCols.filter((pending) => pending !== col);
        if (rowPatches.has(col)) {
          const replacement = rowPatches.get(col)!;
          if (token.kind === "self") replace(token.start, token.end, replacement ?? "");
          else replacingCell = { start: token.start, xml: replacement ?? "" };
        }
        break;
      }
    }
    if (token.kind === "open") path.push(token.name);
  }
  if (path.length) throw new XmlSyntaxError("Unclosed tags");
  copyTo(xml.length);
  return out.join("");
}
