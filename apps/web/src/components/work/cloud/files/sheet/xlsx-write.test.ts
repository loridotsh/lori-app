import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCell } from "./address";
import { pack } from "./package-fixture";
import { patchSheet, type CellPatches } from "./sheet-patch";
import { Calculator, cellKey, lockedReason, parseInput, setInput, type SheetModel } from "./workbook";
import { readWorkbook } from "./xlsx-read";
import { writeWorkbook, WorkbookWriteError, type Edits } from "./xlsx-write";

const kit = () => new Uint8Array(readFileSync(join(import.meta.dirname, "__fixtures__/kit-workbook.xlsx")));

function open(bytes: Uint8Array) {
  const { workbook } = readWorkbook(bytes);
  const calc = new Calculator(workbook);
  const edits: Edits = { cells: new Map() };
  const edit = (sheet: SheetModel, address: string, text: string) => {
    const at = parseCell(address)!;
    setInput(calc, sheet, at.row, at.col, parseInput(text, workbook.date1904));
    const keys = edits.cells.get(sheet) ?? new Set<number>();
    keys.add(cellKey(at.row, at.col));
    edits.cells.set(sheet, keys);
  };
  const sheet = (name: string) => workbook.sheets.find((item) => item.name === name)!;
  const value = (name: string, address: string) => {
    const at = parseCell(address)!;
    return calc.value(sheet(name), at.row, at.col);
  };
  return { workbook, calc, edits, edit, sheet, value };
}

const patch = (xml: string, changes: Record<string, Record<string, string | null>>, dimension: string | null = null) => {
  const patches: CellPatches = new Map();
  for (const [row, cols] of Object.entries(changes)) patches.set(Number(row) - 1, new Map(Object.entries(cols).map(([col, text]) => [col.charCodeAt(0) - 65, text])));
  return patchSheet(xml, patches, dimension);
};

describe("sheet patching", () => {
  const sheet = '<worksheet xmlns="x"><dimension ref="A1:B2"/><sheetData><row r="1" spans="1:2"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row><row r="3"><c r="A3"><v>9</v></c></row></sheetData><mergeCells count="0"/></worksheet>';
  it("leaves the text alone when nothing changes", () => {
    expect(patch(sheet, {})).toBe(sheet);
  });
  it("replaces, inserts in column order, appends and removes cells", () => {
    expect(patch(sheet, { 1: { A: '<c r="A1"><v>10</v></c>' } })).toContain('<row r="1"><c r="A1"><v>10</v></c><c r="C1">');
    expect(patch(sheet, { 1: { B: '<c r="B1"><v>2</v></c>' } })).toContain('<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1">');
    expect(patch(sheet, { 1: { D: '<c r="D1"><v>4</v></c>' } })).toContain('<c r="C1"><v>3</v></c><c r="D1"><v>4</v></c></row>');
    expect(patch(sheet, { 1: { C: null } })).toContain('<c r="A1"><v>1</v></c></row>');
  });
  it("drops the row's cached spans only when the row changes", () => {
    expect(patch(sheet, { 1: { B: '<c r="B1"/>' } })).not.toContain("spans");
    expect(patch(sheet, { 3: { B: '<c r="B3"/>' } })).toContain('spans="1:2"');
  });
  it("adds rows in order: before, between and after the existing ones", () => {
    const out = patch(sheet, { 2: { A: '<c r="A2"><v>5</v></c>' }, 4: { A: '<c r="A4"><v>7</v></c>' } });
    expect(out.indexOf('<row r="1"')).toBeLessThan(out.indexOf('<row r="2"'));
    expect(out.indexOf('<row r="2"')).toBeLessThan(out.indexOf('<row r="3"'));
    expect(out.indexOf('<row r="3"')).toBeLessThan(out.indexOf('<row r="4"'));
    expect(out).toContain('<row r="4"><c r="A4"><v>7</v></c></row></sheetData>');
    expect(patch('<worksheet><sheetData><row r="5"><c r="A5"/></row></sheetData></worksheet>', { 2: { A: '<c r="A2"/>' } })).toMatch(/<row r="2">.*<row r="5">/);
  });
  it("fills empty and self-closing containers", () => {
    expect(patch('<worksheet><sheetData/></worksheet>', { 1: { A: '<c r="A1"/>' } })).toBe('<worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>');
    expect(patch('<worksheet><sheetData><row r="1" ht="20"/></sheetData></worksheet>', { 1: { A: '<c r="A1"><v>1</v></c>' } })).toBe('<worksheet><sheetData><row r="1" ht="20"><c r="A1"><v>1</v></c></row></sheetData></worksheet>');
    expect(patch('<worksheet><sheetData><row r="1"><c r="A1" s="2"/></row></sheetData></worksheet>', { 1: { A: '<c r="A1" s="2"><v>1</v></c>' } })).toContain('<c r="A1" s="2"><v>1</v></c>');
  });
  it("updates the dimension and nothing else outside the cells", () => {
    expect(patch(sheet, { 1: { A: '<c r="A1"/>' } }, "A1:D9")).toContain('<dimension ref="A1:D9"/>');
    expect(patch(sheet, { 1: { A: '<c r="A1"/>' } }, "A1:D9")).toContain('<mergeCells count="0"/></worksheet>');
  });
  it("copies everything else byte for byte, including odd whitespace, comments and CDATA", () => {
    const odd = '<?xml version="1.0"?>\n<worksheet xmlns="x">\n  <!-- keep --> <sheetPr><tabColor rgb="FF112233"/></sheetPr>\n<sheetData>\n  <row r="1">\n    <c r="A1" t="inlineStr"><is><t><![CDATA[a<b]]></t></is></c>\n  </row>\n</sheetData>\n<extLst><ext uri="{x}"><x:y xmlns:x="z">1 &lt; 2</x:y></ext></extLst>\n</worksheet>';
    const out = patch(odd, { 1: { B: '<c r="B1"/>' } });
    expect(out.replace('<c r="B1"/>', "")).toBe(odd);
  });
  it("refuses damaged xml", () => {
    expect(() => patch("<worksheet><sheetData><row r='1'>", { 1: { A: "<c/>" } })).toThrow();
    expect(() => patch("<worksheet><sheetData></row></worksheet>", { 1: { A: "<c/>" } })).toThrow();
  });
});

describe("saving an edited workbook", () => {
  it("returns the original bytes when nothing changed", () => {
    const bytes = kit();
    const { calc, edits } = open(bytes);
    expect(writeWorkbook(bytes, calc, edits)).toBe(bytes);
  });
  it("saves an edited value, recalculates dependents everywhere and keeps every other part identical", () => {
    const bytes = kit();
    const session = open(bytes);
    const before = {
      emeaTotal: session.value("EMEA", "G26") as number,
      combined: session.value("Summary", "B6") as number,
    };
    // EMEA's first data row is 6: units in E, unit price in F, total in G.
    const units = session.value("EMEA", "E6") as number;
    const price = session.value("EMEA", "F6") as number;
    session.edit(session.sheet("EMEA"), "E6", String(units + 10));
    const saved = writeWorkbook(bytes, session.calc, session.edits);
    const reread = open(saved);
    expect(reread.value("EMEA", "E6")).toBe(units + 10);
    expect(reread.workbook.sheets.map((s) => s.name)).toEqual(["EMEA", "APAC", "AMER", "Summary"]);
    // Dependent totals changed on this sheet and on the summary, and the file stores the new results.
    const raised = before.emeaTotal + 10 * price;
    expect(reread.value("EMEA", "G6")).toBe((units + 10) * price);
    expect(reread.sheet("EMEA").cells.get(cellKey(25, 6))!.value).toBe(raised);
    expect(reread.sheet("Summary").cells.get(cellKey(5, 1))!.value).toBe(before.combined + 10 * price);
    for (const sheet of reread.workbook.sheets) for (const cell of sheet.cells.values()) if (cell.formula) expect(cell.value).not.toBeNull();
    expect(reread.calc.recalculateAll()).toEqual([]);

    const original = unzipSync(bytes);
    const result = unzipSync(saved);
    const changed = Object.keys(original).filter((name) => !result[name] || strFromU8(original[name]!) !== strFromU8(result[name]!));
    // Only the sheets whose cells moved differ. (This writer already asks Excel to recalculate on load,
    // and has no calc chain, so the workbook-level parts are unchanged too.)
    expect(changed.filter((name) => !name.startsWith("xl/worksheets/"))).toEqual([]);
    expect(changed.sort()).toEqual(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet4.xml"]);
    expect(Object.keys(result)).not.toContain("xl/calcChain.xml");
    expect(strFromU8(result["xl/workbook.xml"]!)).toContain('fullCalcOnLoad="1"');
    expect(strFromU8(result["[Content_Types].xml"]!)).not.toContain("calcChain");
    for (const name of Object.keys(original).filter((n) => /charts|drawings|theme|media|docProps/.test(n))) expect(strFromU8(result[name]!)).toBe(strFromU8(original[name]!));
  });
  it("writes text, numbers, booleans, formulas and clears, escaping what needs it", () => {
    const bytes = pack('<dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>');
    const session = open(bytes);
    const sheet = session.sheet("Data");
    session.edit(sheet, "A1", "5");
    session.edit(sheet, "B1", "R&D <team> \"x\"");
    session.edit(sheet, "C1", "=A1*2");
    session.edit(sheet, "D1", "true");
    session.edit(sheet, "A3", "=B1&\"!\"");
    session.edit(sheet, "E1", "temp");
    session.edit(sheet, "E1", "");
    const saved = writeWorkbook(bytes, session.calc, session.edits);
    const reread = open(saved);
    expect([5, "R&D <team> \"x\"", 10, true].map((_, i) => reread.value("Data", `${"ABCD"[i]}1`))).toEqual([5, 'R&D <team> "x"', 10, true]);
    expect(reread.value("Data", "A3")).toBe('R&D <team> "x"!');
    expect(reread.sheet("Data").cells.has(cellKey(0, 4))).toBe(false);
    const xml = strFromU8(unzipSync(saved)["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain('<dimension ref="A1:D3"/>');
    expect(xml.indexOf('<row r="1"')).toBeLessThan(xml.indexOf('<row r="3"'));
  });
  it("keeps a typed percentage or date formatted as one", () => {
    const styles =
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="center"/></xf></cellXfs></styleSheet>';
    const bytes = pack('<sheetData><row r="1"><c r="A1" s="1"/></row></sheetData>', { "xl/styles.xml": styles });
    const session = open(bytes);
    const sheet = session.sheet("Data");
    session.edit(sheet, "A1", "12%");
    session.edit(sheet, "B1", "2026-07-14");
    const saved = writeWorkbook(bytes, session.calc, session.edits);
    const text = strFromU8(unzipSync(saved)["xl/styles.xml"]!);
    expect(text).toContain('<cellXfs count="4">');
    const reread = open(saved);
    expect(reread.calc.format(reread.sheet("Data"), 0, 0).text).toBe("12%");
    expect(reread.calc.format(reread.sheet("Data"), 0, 1).text).toBe("7/14/2026");
    // The percent style was derived from the cell's own (centred) style, not the default.
    expect(reread.workbook.styles.resolve(reread.sheet("Data").cells.get(0)!.style).horizontal).toBe("center");
  });
  it("turns a shared formula group into ordinary formulas when one of its cells is edited", () => {
    const rows = [1, 2, 3].map((r) => `<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}">${r === 1 ? '<f t="shared" ref="B1:B3" si="0">A1*10</f>' : '<f t="shared" si="0"/>'}<v>${r * 10}</v></c></row>`).join("");
    const bytes = pack(`<sheetData>${rows}</sheetData>`);
    const session = open(bytes);
    session.edit(session.sheet("Data"), "B2", "=A2*100");
    const saved = writeWorkbook(bytes, session.calc, session.edits);
    const xml = strFromU8(unzipSync(saved)["xl/worksheets/sheet1.xml"]!);
    expect(xml).not.toContain('t="shared"');
    const reread = open(saved);
    expect([reread.value("Data", "B1"), reread.value("Data", "B2"), reread.value("Data", "B3")]).toEqual([10, 200, 30]);
  });
  it("keeps a shared formula group shared when only its stored results change", () => {
    const rows = [1, 2, 3].map((r) => `<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}">${r === 1 ? '<f t="shared" ref="B1:B3" si="0">A1*10</f>' : '<f t="shared" si="0"/>'}<v>${r * 10}</v></c></row>`).join("");
    const bytes = pack(`<sheetData>${rows}</sheetData>`);
    const session = open(bytes);
    session.edit(session.sheet("Data"), "A2", "7");
    const saved = writeWorkbook(bytes, session.calc, session.edits);
    const xml = strFromU8(unzipSync(saved)["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain('<f t="shared" si="0"/>');
    expect(xml).toMatch(/<f t="shared" (ref="B1:B3" si="0"|si="0" ref="B1:B3")>A1\*10<\/f>/);
    const reread = open(saved);
    expect([reread.value("Data", "B1"), reread.value("Data", "B2"), reread.value("Data", "B3")]).toEqual([10, 70, 30]);
    expect(reread.sheet("Data").cells.get(cellKey(1, 1))!.value).toBe(70);
  });
  it("only rewrites what changed on the next save", () => {
    const bytes = pack('<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row></sheetData>');
    const session = open(bytes);
    session.edit(session.sheet("Data"), "A1", "4");
    const first = writeWorkbook(bytes, session.calc, session.edits);
    session.edits.cells.clear();
    expect(writeWorkbook(first, session.calc, session.edits)).toBe(first);
  });
  it("protects array formulas and refuses sheets it cannot rewrite safely", () => {
    const array = open(pack('<sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A2">{1;2}</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'));
    expect(lockedReason(array.sheet("Data"), 1, 0)).toMatch(/array formula/);
    expect(lockedReason(array.sheet("Data"), 2, 0)).toBeNull();
    const files = unzipSync(pack('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'));
    files["xl/worksheets/sheet1.xml"] = strToU8('<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>');
    const bytes = zipSync(files);
    const session = open(bytes);
    expect(session.value("Data", "A1")).toBe(1);
    session.edit(session.sheet("Data"), "B1", "x");
    expect(() => writeWorkbook(bytes, session.calc, session.edits)).toThrow(WorkbookWriteError);
  });
});
