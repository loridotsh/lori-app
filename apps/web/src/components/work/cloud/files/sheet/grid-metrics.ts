/** Pixel geometry of a sheet: column and row offsets, merged cells, and what is visible. */
import type { Bounds } from "./address";
import { cellKey, type SheetModel } from "./workbook";

/** Excel's column width unit is a character of the default font; ~7 px plus padding at 96 dpi. */
export const colPixels = (width: number): number => Math.max(0, Math.round(width * 7 + 5));
export const rowPixels = (points: number): number => Math.max(0, Math.round((points * 96) / 72));

export const HEADER_WIDTH = 46;
export const HEADER_HEIGHT = 24;

export interface Metrics {
  rows: number;
  cols: number;
  /** x[c] is the left edge of column c; x[cols] is the total width. */
  x: number[];
  y: number[];
  freezeRows: number;
  freezeCols: number;
  /** Merged cells keyed by their top-left corner, and every covered cell mapped to its top-left. */
  mergeAt: Map<number, Bounds>;
  coveredBy: Map<number, number>;
}

/** Rows and columns shown beyond the used range, so a member can type past the last cell. */
const EXTRA_ROWS = 40;
const EXTRA_COLS = 6;

export function buildMetrics(sheet: SheetModel, maxRows = 100_000, maxCols = 2_000): Metrics {
  const rows = Math.min(maxRows, Math.max(sheet.rows + EXTRA_ROWS, 60));
  const cols = Math.min(maxCols, Math.max(sheet.cols + EXTRA_COLS, 14));
  const x = new Array<number>(cols + 1);
  const y = new Array<number>(rows + 1);
  x[0] = 0;
  y[0] = 0;
  for (let c = 0; c < cols; c++) x[c + 1] = x[c]! + (sheet.hiddenCols.has(c) ? 0 : colPixels(sheet.colWidths.get(c) ?? sheet.defaultColWidth));
  for (let r = 0; r < rows; r++) y[r + 1] = y[r]! + (sheet.hiddenRows.has(r) ? 0 : rowPixels(sheet.rowHeights.get(r) ?? sheet.defaultRowHeight));
  const mergeAt = new Map<number, Bounds>();
  const coveredBy = new Map<number, number>();
  for (const merge of sheet.merges) {
    const corner = cellKey(merge.r1, merge.c1);
    mergeAt.set(corner, merge);
    // Bounded: a merge over a huge block must not allocate millions of entries.
    if ((merge.r2 - merge.r1 + 1) * (merge.c2 - merge.c1 + 1) > 20_000) continue;
    for (let r = merge.r1; r <= merge.r2; r++)
      for (let c = merge.c1; c <= merge.c2; c++) if (r !== merge.r1 || c !== merge.c1) coveredBy.set(cellKey(r, c), corner);
  }
  return { rows, cols, x, y, freezeRows: Math.min(sheet.freezeRows, rows), freezeCols: Math.min(sheet.freezeCols, cols), mergeAt, coveredBy };
}

/** The index i with offsets[i] <= position < offsets[i + 1]. */
export function indexAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (position <= 0) return 0;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface Window {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

/** The scrolling rows and columns that intersect the viewport, with a little overscan. */
export function visibleWindow(m: Metrics, scrollLeft: number, scrollTop: number, width: number, height: number, overscan = 2): Window {
  const frozenX = m.x[m.freezeCols]!;
  const frozenY = m.y[m.freezeRows]!;
  const c1 = Math.max(m.freezeCols, indexAt(m.x, scrollLeft + frozenX) - overscan);
  const c2 = Math.min(m.cols - 1, indexAt(m.x, scrollLeft + width) + overscan);
  const r1 = Math.max(m.freezeRows, indexAt(m.y, scrollTop + frozenY) - overscan);
  const r2 = Math.min(m.rows - 1, indexAt(m.y, scrollTop + height) + overscan);
  return { r1, r2, c1, c2 };
}

/** Rows (or columns) to draw: the frozen ones always, then the visible scrolling ones. */
export function span(freeze: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < freeze; i++) out.push(i);
  for (let i = Math.max(from, freeze); i <= to; i++) out.push(i);
  return out;
}

/** The pixel box of a cell, using its merged area when it is the corner of a merge. */
export function cellBox(m: Metrics, row: number, col: number): { left: number; top: number; width: number; height: number } {
  const merge = m.mergeAt.get(cellKey(row, col));
  const r2 = merge ? Math.min(merge.r2, m.rows - 1) : row;
  const c2 = merge ? Math.min(merge.c2, m.cols - 1) : col;
  return { left: m.x[col]!, top: m.y[row]!, width: m.x[c2 + 1]! - m.x[col]!, height: m.y[r2 + 1]! - m.y[row]! };
}

/** Where the viewport must scroll so a cell is fully visible, or null when it already is. */
export function scrollToReveal(
  m: Metrics,
  row: number,
  col: number,
  scrollLeft: number,
  scrollTop: number,
  width: number,
  height: number,
): { left: number; top: number } | null {
  const box = cellBox(m, row, col);
  const frozenX = m.x[m.freezeCols]!;
  const frozenY = m.y[m.freezeRows]!;
  let left = scrollLeft;
  let top = scrollTop;
  if (col >= m.freezeCols) {
    if (box.left - frozenX < scrollLeft) left = box.left - frozenX;
    else if (box.left + box.width > scrollLeft + width) left = box.left + box.width - width;
  }
  if (row >= m.freezeRows) {
    if (box.top - frozenY < scrollTop) top = box.top - frozenY;
    else if (box.top + box.height > scrollTop + height) top = box.top + box.height - height;
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  return left === scrollLeft && top === scrollTop ? null : { left, top };
}

/** Moves a cell position one step, skipping hidden rows and columns, clamped to the grid. */
export function step(sheet: SheetModel, m: Metrics, row: number, col: number, dRow: number, dCol: number): { row: number; col: number } {
  let r = row;
  let c = col;
  const merge = [...m.mergeAt.values()].find((item) => row >= item.r1 && row <= item.r2 && col >= item.c1 && col <= item.c2);
  if (merge) {
    // Leave a merged block from its far edge in the direction of travel.
    if (dRow > 0) r = merge.r2;
    if (dCol > 0) c = merge.c2;
    if (dRow < 0) r = merge.r1;
    if (dCol < 0) c = merge.c1;
  }
  do r = Math.max(0, Math.min(m.rows - 1, r + dRow));
  while (dRow && sheet.hiddenRows.has(r) && r > 0 && r < m.rows - 1);
  do c = Math.max(0, Math.min(m.cols - 1, c + dCol));
  while (dCol && sheet.hiddenCols.has(c) && c > 0 && c < m.cols - 1);
  const corner = m.coveredBy.get(cellKey(r, c));
  if (corner !== undefined) {
    const owner = m.mergeAt.get(corner)!;
    return { row: owner.r1, col: owner.c1 };
  }
  return { row: r, col: c };
}

/** A covered cell resolves to the corner of the merge that covers it. */
export function resolveCorner(m: Metrics, row: number, col: number): { row: number; col: number } {
  const corner = m.coveredBy.get(cellKey(row, col));
  if (corner === undefined) return { row, col };
  const owner = m.mergeAt.get(corner)!;
  return { row: owner.r1, col: owner.c1 };
}
