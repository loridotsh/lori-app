import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { cellName } from "./address";
import { pack } from "./package-fixture";
import { LIMITS, readWorkbook, WorkbookReadError } from "./xlsx-read";
import { Calculator, cellKey, keyCol, keyRow } from "./workbook";
import { formatValue } from "./numfmt";
import { shiftFormula } from "./formula-shift";

const fixture = () => new Uint8Array(readFileSync(join(import.meta.dirname, "__fixtures__/kit-workbook.xlsx")));

describe("reading a workbook made by the design kit", () => {
  const { workbook } = readWorkbook(fixture());
  const calc = new Calculator(workbook);
  const summary = workbook.sheets.find((sheet) => sheet.name === "Summary")!;
  it("finds the sheets, in file order, with their layout", () => {
    expect(workbook.sheets.map((s) => s.name)).toEqual(["EMEA", "APAC", "AMER", "Summary"]);
    expect(workbook.sheets[workbook.activeSheet]!.name).toBe("Summary");
    expect(summary.tabColor).toBe("#1E3A5F");
    expect(summary.showGridLines).toBe(false);
    expect(summary.drawings).toBeGreaterThan(0);
    expect(summary.merges).toEqual(expect.arrayContaining([{ r1: 4, c1: 1, r2: 4, c2: 2 }, { r1: 5, c1: 1, r2: 5, c2: 2 }]));
    const emea = workbook.sheets[0]!;
    expect(emea.freezeRows).toBeGreaterThan(0);
    expect(emea.colWidths.size).toBeGreaterThan(3);
  });
  it("keeps the values the file stored next to every formula", () => {
    const emea = workbook.sheets[0]!;
    const totals = [...emea.cells.values()].filter((cell) => cell.formula);
    expect(totals.length).toBeGreaterThan(20);
    for (const cell of totals) expect(cell.value).not.toBeNull();
  });
  it("calculates the same numbers the file stored", () => {
    // No formula's recalculated value may differ from what the writer cached.
    expect(calc.recalculateAll()).toEqual([]);
    expect(calc.stats()).toEqual({ approximate: 0, circular: false, unsupported: [] });
  });
  it("resolves number formats and styles for display", () => {
    const emea = workbook.sheets[0]!;
    const texts = [...emea.cells].map(([key]) => calc.format(emea, keyRow(key), keyCol(key)).text);
    expect(texts.some((text) => /^\$[\d,]+$/.test(text))).toBe(true);
    expect(texts.some((text) => /^\d{4}-\d{2}-\d{2}$/.test(text))).toBe(true);
    const header = [...emea.cells.values()].find((cell) => cell.value === "Customer")!;
    const style = workbook.styles.resolve(header.style);
    expect(style.bold).toBe(true);
    expect(style.fill).toMatch(/^#[0-9A-F]{6}$/);
  });
  it("reports the extent of used cells", () => {
    expect(workbook.sheets[0]!.rows).toBeGreaterThan(20);
    expect(workbook.sheets[0]!.cols).toBe(7);
    expect(cellName(0, 0)).toBe("A1");
  });
});

describe("reading Excel-style features", () => {
  it("expands shared formulas to every cell in the block", () => {
    const { workbook } = readWorkbook(
      pack(
        `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*10</f><v>10</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>20</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>30</v></c></row></sheetData>`,
      ),
    );
    const sheet = workbook.sheets[0]!;
    expect(sheet.cells.get(cellKey(0, 1))!.formula).toBe("A1*10");
    expect(sheet.cells.get(cellKey(1, 1))!.formula).toBe("A2*10");
    expect(sheet.cells.get(cellKey(2, 1))).toMatchObject({ formula: "A3*10", shared: 0, value: 30 });
  });
  it("decodes every cell type", () => {
    const { workbook } = readWorkbook(
      pack(
        `<sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="inlineStr"><is><t>inline</t></is></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#DIV/0!</v></c><c r="E1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="F1"><v>1.5E3</v></c><c r="G1" t="inlineStr"><is><r><t>rich </t></r><r><t>text</t></r></is></c></row></sheetData>`,
        { "xl/sharedStrings.xml": '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>zero</t></si><si><r><t>shared </t></r><r><t>one</t></r><rPh><t>ignored</t></rPh></si></sst>' },
      ),
    );
    const cells = workbook.sheets[0]!.cells;
    const at = (col: number) => cells.get(cellKey(0, col))!.value;
    expect(at(0)).toBe("shared one");
    expect(at(1)).toBe("inline");
    expect(at(2)).toBe(true);
    expect(String(at(3))).toBe("#DIV/0!");
    expect(at(4)).toBe("ab");
    expect(at(5)).toBe(1500);
    expect(at(6)).toBe("rich text");
  });
  it("resolves theme and tinted colours, borders, fonts and alignment", () => {
    const styles =
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot; x&quot;"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color theme="4"/><name val="Arial"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>' +
      '<borders count="2"><border/><border><bottom style="thin"><color rgb="FF112233"/></bottom></border></borders>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="top" wrapText="1" indent="2"/></xf></cellXfs></styleSheet>';
    const theme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>';
    const { workbook } = readWorkbook(pack('<sheetData><row r="1"><c r="A1" s="1"><v>3</v></c></row></sheetData>', { "xl/styles.xml": styles, "xl/theme/theme1.xml": theme }));
    const style = workbook.styles.resolve(1);
    expect(style).toMatchObject({ bold: true, italic: true, fontSize: 14, fontName: "Arial", color: "#4472C4", numFmt: '0.0" x"', horizontal: "center", vertical: "top", wrap: true, indent: 2 });
    // accent1 lightened by 50%: the same hue, much lighter than the accent itself.
    expect(style.fill).toMatch(/^#[0-9A-F]{6}$/);
    expect(style.fill).not.toBe("#4472C4");
    expect(parseInt(style.fill!.slice(1, 3), 16)).toBeGreaterThan(0x44 + 0x20);
    expect(style.border.bottom).toEqual({ style: "thin", color: "#112233" });
    expect(formatValue(3, style.numFmt).text).toBe("3.0 x");
  });
  it("reads hidden rows and columns, row heights, freeze panes and merged ranges", () => {
    const { workbook } = readWorkbook(
      pack(
        '<sheetViews><sheetView showGridLines="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="2" max="3" width="20" customWidth="1"/><col min="4" max="4" width="9" hidden="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row><row r="2" hidden="1"><c r="A2"><v>2</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>',
      ),
    );
    const sheet = workbook.sheets[0]!;
    expect(sheet).toMatchObject({ freezeRows: 2, freezeCols: 1, showGridLines: false, defaultRowHeight: 18 });
    expect(sheet.colWidths.get(1)).toBe(20);
    expect(sheet.colWidths.get(2)).toBe(20);
    expect([...sheet.hiddenCols]).toEqual([3]);
    expect(sheet.rowHeights.get(0)).toBe(30);
    expect([...sheet.hiddenRows]).toEqual([1]);
    expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
    expect(sheet.cols).toBe(3);
  });
  it("resolves workbook-level defined names but not sheet-scoped ones", () => {
    const { workbook } = readWorkbook(pack("<sheetData/>", {}, '<definedNames><definedName name="Rate">Data!$B$1</definedName><definedName name="Local" localSheetId="0">Data!$A$1</definedName></definedNames>'));
    expect([...workbook.definedNames]).toEqual([["Rate", "Data!$B$1"]]);
  });
  it("flags parts it does not render", () => {
    const { workbook } = readWorkbook(pack("<sheetData/>", { "xl/vbaProject.bin": "x", "xl/pivotTables/pivotTable1.xml": "<x/>" }));
    expect(workbook.unsupported).toEqual(["macros", "pivot tables"]);
  });
});

describe("shared formula translation", () => {
  it("moves relative references and leaves absolute ones", () => {
    expect(shiftFormula("A1*$B$1+C$2+$D3", 2, 1)).toBe("B3*$B$1+D$2+$D5");
    expect(shiftFormula('SUM(A1:A3)&"A1"', 1, 0)).toBe('SUM(A2:A4)&"A1"');
    expect(shiftFormula("Sheet1!A1+'My Sheet'!B2", 1, 1)).toBe("Sheet1!B2+'My Sheet'!C3");
    expect(shiftFormula("Q1!A1", 1, 0)).toBe("Q1!A2");
    expect(shiftFormula("SUM(A:A)", 0, 2)).toBe("SUM(C:C)");
    expect(shiftFormula("SUM($A:$A)", 0, 2)).toBe("SUM($A:$A)");
    expect(shiftFormula("SUM(1:1)", 3, 0)).toBe("SUM(4:4)");
    expect(shiftFormula("LOG10(A1)+Rate", 1, 0)).toBe("LOG10(A2)+Rate");
    expect(shiftFormula("A1", -1, 0)).toBe("#REF!");
  });
});

describe("hostile and broken files", () => {
  it("refuses things that are not workbooks, with a reason", () => {
    const reason = (bytes: Uint8Array) => {
      try {
        readWorkbook(bytes);
        return "read";
      } catch (error) {
        return error instanceof WorkbookReadError ? error.reason : "other";
      }
    };
    expect(reason(new Uint8Array([1, 2, 3]))).toBe("not_workbook");
    expect(reason(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toBe("encrypted");
    expect(reason(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]))).toBe("corrupt");
    expect(reason(zipSync({ "hello.txt": strToU8("hi") }))).toBe("not_workbook");
    expect(reason(pack("<sheetData><row><c r='A1'>"))).toBe("corrupt");
  });
  it("stops at its limits instead of exhausting memory", () => {
    const rows = Array.from({ length: 50 }, (_, r) => `<row r="${r + 1}">${Array.from({ length: 26 }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${c}</v></c>`).join("")}</row>`).join("");
    const original = LIMITS.cells;
    LIMITS.cells = 1000;
    try {
      expect(() => readWorkbook(pack(`<sheetData>${rows}</sheetData>`))).toThrow(WorkbookReadError);
      LIMITS.cells = 1300;
      expect(readWorkbook(pack(`<sheetData>${rows}</sheetData>`)).workbook.sheets[0]!.cells.size).toBe(1300);
    } finally {
      LIMITS.cells = original;
    }
    const originalSheet = LIMITS.sheetBytes;
    LIMITS.sheetBytes = 100;
    try {
      expect(() => readWorkbook(pack(`<sheetData>${rows}</sheetData>`))).toThrow(/too large/);
    } finally {
      LIMITS.sheetBytes = originalSheet;
    }
  });
  it("does not follow external relationship targets", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="X" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="https://evil.example/sheet.xml" TargetMode="External"/></Relationships>'),
    });
    expect(() => readWorkbook(bytes)).toThrow(WorkbookReadError);
  });
});
