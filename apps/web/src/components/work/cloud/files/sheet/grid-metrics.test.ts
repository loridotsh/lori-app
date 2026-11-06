import { describe, expect, it } from "vitest";
import { buildMetrics, cellBox, colPixels, indexAt, resolveCorner, rowPixels, scrollToReveal, span, step, visibleWindow } from "./grid-metrics";
import { emptySheet } from "./workbook-fixture";

function sheetWith(setup: (sheet: ReturnType<typeof emptySheet>) => void) {
  const sheet = emptySheet("S");
  sheet.rows = 100;
  sheet.cols = 10;
  setup(sheet);
  return sheet;
}

describe("sheet geometry", () => {
  it("converts Excel's units to pixels", () => {
    expect(colPixels(8.43)).toBe(64);
    expect(colPixels(0)).toBe(5);
    expect(rowPixels(15)).toBe(20);
    expect(rowPixels(30)).toBe(40);
  });
  it("builds offsets with custom, default and hidden sizes", () => {
    const sheet = sheetWith((s) => {
      s.colWidths.set(1, 20);
      s.hiddenCols.add(2);
      s.rowHeights.set(0, 30);
      s.hiddenRows.add(1);
    });
    const m = buildMetrics(sheet);
    expect(m.x.slice(0, 5)).toEqual([0, 64, 64 + 145, 64 + 145, 64 + 145 + 64]);
    expect(m.y.slice(0, 4)).toEqual([0, 40, 40, 60]);
    expect(m.rows).toBe(140);
    expect(m.cols).toBe(16);
  });
  it("always leaves room to type past the used range, within limits", () => {
    expect(buildMetrics(emptySheet("E")).rows).toBe(60);
    expect(buildMetrics(emptySheet("E")).cols).toBe(14);
    const huge = emptySheet("H");
    huge.rows = 5_000_000;
    huge.cols = 50_000;
    const m = buildMetrics(huge);
    expect(m.rows).toBe(100_000);
    expect(m.cols).toBe(2_000);
  });
  it("finds the cell at a pixel position", () => {
    const offsets = [0, 10, 30, 30, 60];
    expect([-5, 0, 9, 10, 29, 30, 59, 60, 500].map((p) => indexAt(offsets, p))).toEqual([0, 0, 0, 1, 1, 3, 3, 3, 3]);
  });
  it("computes the visible window including frozen panes and overscan", () => {
    const sheet = sheetWith((s) => {
      s.freezeRows = 2;
      s.freezeCols = 1;
    });
    const m = buildMetrics(sheet);
    const top = visibleWindow(m, 0, 0, 300, 100, 0);
    expect(top).toEqual({ r1: 2, r2: 5, c1: 1, c2: 4 });
    const scrolled = visibleWindow(m, 640, 2000, 300, 100, 1);
    expect(scrolled.c1).toBeGreaterThanOrEqual(1);
    expect(scrolled.r1).toBeGreaterThan(2);
    expect(span(2, scrolled.r1, scrolled.r2).slice(0, 2)).toEqual([0, 1]);
  });
  it("tracks merged cells", () => {
    const sheet = sheetWith((s) => s.merges.push({ r1: 1, c1: 1, r2: 2, c2: 3 }));
    const m = buildMetrics(sheet);
    expect(cellBox(m, 1, 1)).toEqual({ left: 64, top: 20, width: 192, height: 40 });
    expect(resolveCorner(m, 2, 3)).toEqual({ row: 1, col: 1 });
    expect(resolveCorner(m, 5, 5)).toEqual({ row: 5, col: 5 });
    expect(step(sheet, m, 1, 1, 0, 1)).toEqual({ row: 1, col: 4 });
    expect(step(sheet, m, 0, 2, 1, 0)).toEqual({ row: 1, col: 1 });
    expect(step(sheet, m, 3, 2, -1, 0)).toEqual({ row: 1, col: 1 });
  });
  it("steps over hidden rows and columns and stops at the edges", () => {
    const sheet = sheetWith((s) => {
      s.hiddenRows.add(1);
      s.hiddenCols.add(1);
    });
    const m = buildMetrics(sheet);
    expect(step(sheet, m, 0, 0, 1, 0)).toEqual({ row: 2, col: 0 });
    expect(step(sheet, m, 0, 0, 0, 1)).toEqual({ row: 0, col: 2 });
    expect(step(sheet, m, 0, 0, -1, -1)).toEqual({ row: 0, col: 0 });
    expect(step(sheet, m, m.rows - 1, m.cols - 1, 1, 1)).toEqual({ row: m.rows - 1, col: m.cols - 1 });
  });
  it("scrolls just enough to reveal a cell", () => {
    const m = buildMetrics(sheetWith(() => {}));
    expect(scrollToReveal(m, 0, 0, 0, 0, 300, 200)).toBeNull();
    expect(scrollToReveal(m, 30, 0, 0, 0, 300, 200)).toEqual({ left: 0, top: m.y[31]! - 200 });
    expect(scrollToReveal(m, 0, 8, 0, 0, 300, 200)).toEqual({ left: m.x[9]! - 300, top: 0 });
    expect(scrollToReveal(m, 1, 1, 500, 500, 300, 200)).toEqual({ left: 64, top: 20 });
  });
});
