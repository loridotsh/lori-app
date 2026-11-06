import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pack } from "./package-fixture";
import { formatTabular, parseTabular, SheetSession } from "./sheet-session";
import { cellKey } from "./workbook";

const kit = () => new Uint8Array(readFileSync(join(import.meta.dirname, "__fixtures__/kit-workbook.xlsx")));
const small = () => new SheetSession(pack('<sheetData><row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*10</f><v>20</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>hello</t></is></c></row></sheetData>'));

describe("clipboard text", () => {
  it("round trips cells containing tabs, newlines and quotes", () => {
    const rows = [["a", 'say "hi"', "line\nbreak"], ["x\ty", "", "z"]];
    expect(parseTabular(formatTabular(rows))).toEqual(rows);
  });
  it("reads what spreadsheets put on the clipboard", () => {
    expect(parseTabular("1\t2\n3\t4\n")).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseTabular("a\r\nb\r\n")).toEqual([["a"], ["b"]]);
    expect(parseTabular("only")).toEqual([["only"]]);
    expect(parseTabular("")).toEqual([]);
    expect(parseTabular("a\t\tc")).toEqual([["a", "", "c"]]);
  });
});

describe("a sheet editing session", () => {
  it("shows what a member would type to get each cell back", () => {
    const s = small();
    const sheet = s.workbook.sheets[0]!;
    expect([s.input(sheet, 0, 0), s.input(sheet, 0, 1), s.input(sheet, 1, 0), s.input(sheet, 5, 5)]).toEqual(["2", "=A1*10", "hello", ""]);
    s.apply(sheet, [{ row: 3, col: 0, text: "007" }, { row: 3, col: 1, text: "'007" }, { row: 3, col: 2, text: "=1+1" }]);
    expect([s.input(sheet, 3, 0), s.input(sheet, 3, 1), s.input(sheet, 3, 2)]).toEqual(["7", "'007", "=1+1"]);
    s.apply(sheet, [{ row: 4, col: 0, text: "'=not a formula" }, { row: 4, col: 1, text: "'TRUE" }]);
    expect([s.input(sheet, 4, 0), s.input(sheet, 4, 1)]).toEqual(["'=not a formula", "'TRUE"]);
  });
  it("edits, recalculates, undoes and redoes", () => {
    const s = small();
    const sheet = s.workbook.sheets[0]!;
    const seen = vi.fn();
    s.subscribe(seen);
    expect(s.dirty).toBe(false);
    s.apply(sheet, [{ row: 0, col: 0, text: "5" }]);
    expect(seen).toHaveBeenCalled();
    expect(s.dirty).toBe(true);
    expect(s.calc.value(sheet, 0, 1)).toBe(50);
    s.undo();
    expect(s.calc.value(sheet, 0, 1)).toBe(20);
    expect(s.dirty).toBe(false);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.calc.value(sheet, 0, 1)).toBe(50);
    s.apply(sheet, [{ row: 0, col: 0, text: "9" }]);
    expect(s.canRedo).toBe(false);
    s.undo();
    s.undo();
    expect(s.calc.value(sheet, 0, 1)).toBe(20);
    expect(s.canUndo).toBe(false);
  });
  it("treats a multi-cell paste or clear as one undo step", () => {
    const s = small();
    const sheet = s.workbook.sheets[0]!;
    expect(s.paste(sheet, 5, 1, "1\t2\n3\t4")).toBeNull();
    expect(s.input(sheet, 6, 2)).toBe("4");
    s.undo();
    expect(sheet.cells.has(cellKey(5, 1))).toBe(false);
    s.paste(sheet, 5, 1, "1\t2\n3\t4");
    expect(s.clear(sheet, { r1: 5, c1: 1, r2: 6, c2: 2 })).toBeNull();
    expect([5, 6].every((r) => !sheet.cells.has(cellKey(r, 1)))).toBe(true);
    s.undo();
    expect(s.input(sheet, 5, 2)).toBe("2");
  });
  it("refuses oversized pastes and edits inside array formulas", () => {
    const s = small();
    const sheet = s.workbook.sheets[0]!;
    expect(s.paste(sheet, 0, 0, "x\t".repeat(60_000))).toMatch(/too much/);
    const arrays = new SheetSession(pack('<sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A2">{1;2}</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'));
    const refusal = arrays.apply(arrays.workbook.sheets[0]!, [{ row: 1, col: 0, text: "9" }]);
    expect(refusal).toMatch(/array formula/);
    expect(arrays.dirty).toBe(false);
  });
  it("copies the selection as typed text", () => {
    const s = small();
    expect(s.copyText(s.workbook.sheets[0]!, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe("2\t=A1*10\nhello\t");
  });
  it("saves, becomes clean, and the saved bytes are the next baseline", () => {
    const s = new SheetSession(kit());
    const emea = s.workbook.sheets[0]!;
    s.apply(emea, [{ row: 5, col: 4, text: "99" }]);
    const ticket = s.beginSave();
    s.markSaved(ticket);
    expect(s.dirty).toBe(false);
    expect(s.canUndo).toBe(true);
    // Undoing past the save makes the session dirty again, and the next save restores the original value.
    s.undo();
    expect(s.dirty).toBe(true);
    const second = new SheetSession(s.beginSave().bytes);
    expect(second.input(second.workbook.sheets[0]!, 5, 4)).not.toBe("99");
  });
  it("keeps edits made while a save is in flight as unsaved", () => {
    const s = new SheetSession(kit());
    const emea = s.workbook.sheets[0]!;
    s.apply(emea, [{ row: 5, col: 4, text: "99" }]);
    const ticket = s.beginSave();
    s.apply(emea, [{ row: 6, col: 4, text: "77" }]); // typed while the upload runs
    s.markSaved(ticket);
    expect(s.dirty).toBe(true);
    const next = new SheetSession(s.beginSave().bytes);
    expect(next.input(next.workbook.sheets[0]!, 5, 4)).toBe("99");
    expect(next.input(next.workbook.sheets[0]!, 6, 4)).toBe("77");
    s.markSaved(s.beginSave());
    expect(s.dirty).toBe(false);
  });
  it("can retry after a failed save without losing refreshed results or styles", () => {
    const s = new SheetSession(kit());
    const emea = s.workbook.sheets[0]!;
    s.apply(emea, [{ row: 5, col: 4, text: "99" }, { row: 5, col: 7, text: "12%" }]);
    s.beginSave(); // the upload failed: markSaved is never called
    const retry = s.beginSave();
    const saved = new SheetSession(retry.bytes);
    expect(saved.calc.recalculateAll()).toEqual([]);
    expect(saved.calc.format(saved.workbook.sheets[0]!, 5, 7).text).toBe("12%");
    s.markSaved(retry);
    // The styles that now exist in the file are not added a second time.
    s.apply(emea, [{ row: 6, col: 7, text: "5%" }]);
    const later = new SheetSession(s.beginSave().bytes);
    expect(later.calc.format(later.workbook.sheets[0]!, 6, 7).text).toBe("5%");
    expect(later.calc.format(later.workbook.sheets[0]!, 5, 7).text).toBe("12%");
  });
  it("is not dirty after a no-op edit", () => {
    const s = small();
    s.apply(s.workbook.sheets[0]!, [{ row: 8, col: 8, text: "" }, { row: 9, col: 9, text: "" }]);
    expect(s.dirty).toBe(false);
  });
});
