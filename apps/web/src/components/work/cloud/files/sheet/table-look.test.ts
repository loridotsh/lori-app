import { describe, expect, it } from "vitest";
import { cellLook, unreadableCells } from "./cell-look";
import { pack } from "./package-fixture";
import { contrast, lighten, readableOn, tableLook } from "./table-styles";
import { cellKey, type TableModel } from "./workbook";
import { readWorkbook } from "./xlsx-read";

const THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
const table = (extra: Partial<TableModel> = {}): TableModel => ({
  bounds: { r1: 0, c1: 0, r2: 5, c2: 2 }, hasHeader: true, hasTotals: false, style: "TableStyleMedium2",
  firstColumn: false, lastColumn: false, rowStripes: true, columnStripes: false, ...extra,
});

const STYLES =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><color rgb="00FFFFFF"/></font><font><b/><color rgb="FF000000"/></font></fonts>' +
  '<fills count="3"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/></patternFill></fill></fills><borders count="1"><border/></borders>' +
  '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>';
const TABLE = '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:B4" headerRowCount="1"><tableStyleInfo name="TableStyleMedium2" showRowStripes="1" showColumnStripes="0" showFirstColumn="1"/></table>';
const TABLE_RELS = (target: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="${target}" Id="rId1"/></Relationships>`;
const cells = (header: number) =>
  `<sheetData><row r="1"><c r="A1" s="${header}" t="inlineStr"><is><t>Region</t></is></c><c r="B1" s="${header}" t="inlineStr"><is><t>Sales</t></is></c></row>` +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>EMEA</t></is></c><c r="B2"><v>5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>APAC</t></is></c><c r="B3"><v>6</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>AMER</t></is></c><c r="B4"><v>7</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts>';

describe("table styles", () => {
  it("fills the header with the accent colour in white bold, and bands the body from the first row", () => {
    expect(tableLook(table(), 0, 1, THEME)).toEqual({ fill: "#4472C4", color: "#FFFFFF", bold: true });
    expect(tableLook(table({ style: "TableStyleMedium3" }), 0, 0, THEME)?.fill).toBe("#ED7D31");
    expect(tableLook(table({ style: "TableStyleMedium7" }), 0, 0, THEME)?.fill).toBe("#70AD47");
    expect(tableLook(table(), 1, 0, THEME)?.fill).toBe(lighten("#4472C4", 0.82));
    expect(tableLook(table(), 2, 0, THEME)).toBeNull();
    expect(tableLook(table(), 3, 0, THEME)?.fill).toBe(lighten("#4472C4", 0.82));
  });
  it("respects stripes, first column and totals", () => {
    expect(tableLook(table({ rowStripes: false }), 1, 0, THEME)).toBeNull();
    expect(tableLook(table({ firstColumn: true, rowStripes: false }), 2, 0, THEME)).toEqual({ bold: true });
    const withTotals = table({ hasTotals: true });
    expect(tableLook(withTotals, 5, 0, THEME)).toMatchObject({ bold: true, borderTop: { color: "#4472C4" } });
    expect(tableLook(table({ hasHeader: false }), 0, 0, THEME)?.fill).toBe(lighten("#4472C4", 0.82));
  });
  it("draws the other families without a filled header where Excel does not", () => {
    expect(tableLook(table({ style: "TableStyleLight2" }), 0, 0, THEME)).toMatchObject({ bold: true, color: "#18181B", borderBottom: { color: "#4472C4" } });
    expect(tableLook(table({ style: "TableStyleLight9" }), 0, 0, THEME)).toMatchObject({ fill: "#4472C4", color: "#FFFFFF" });
    expect(tableLook(table({ style: "TableStyleLight16" }), 1, 0, THEME)).toBeNull();
    expect(tableLook(table({ style: "TableStyleDark2" }), 0, 0, THEME)?.fill).toBe("#262626");
    expect(tableLook(table({ style: "TableStyleMedium1" }), 0, 0, THEME)?.fill).toBe("#404040");
  });
  it("knows nothing about a custom or missing style", () => {
    expect(tableLook(table({ style: "MyCompanyStyle" }), 0, 0, THEME)).toBeNull();
    expect(tableLook(table({ style: null }), 0, 0, THEME)).toBeNull();
  });
  it("measures contrast", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(readableOn("#FFFFFF")).toBe("#18181B");
    expect(readableOn("#17365D")).toBe("#FFFFFF");
  });
});

describe("reading tables", () => {
  const open = (target: string) => readWorkbook(pack(cells(1), { "xl/styles.xml": STYLES, "xl/worksheets/_rels/sheet1.xml.rels": TABLE_RELS(target), "xl/tables/table1.xml": TABLE })).workbook;
  it("finds a sheet's tables through its relationships, with relative or absolute targets", () => {
    for (const target of ["../tables/table1.xml", "/xl/tables/table1.xml"]) {
      const [found] = open(target).sheets[0]!.tables;
      expect(found).toMatchObject({ bounds: { r1: 0, c1: 0, r2: 3, c2: 1 }, hasHeader: true, hasTotals: false, style: "TableStyleMedium2", rowStripes: true, columnStripes: false, firstColumn: true });
    }
    expect(open("../tables/table1.xml").theme.slice(4, 10)).toHaveLength(6);
  });
  it("ignores a table it cannot find or read", () => {
    expect(open("../tables/missing.xml").sheets[0]!.tables).toEqual([]);
    const broken = readWorkbook(pack(cells(1), { "xl/styles.xml": STYLES, "xl/worksheets/_rels/sheet1.xml.rels": TABLE_RELS("../tables/table1.xml"), "xl/tables/table1.xml": "<table ref=" })).workbook;
    expect(broken.sheets[0]!.tables).toEqual([]);
  });
});

describe("what a cell looks like", () => {
  const book = (header: number, withTable: boolean) => {
    const files: Record<string, string> = { "xl/styles.xml": STYLES };
    if (withTable) Object.assign(files, { "xl/worksheets/_rels/sheet1.xml.rels": TABLE_RELS("../tables/table1.xml"), "xl/tables/table1.xml": TABLE });
    const { workbook } = readWorkbook(pack(withTable ? cells(header) : cells(header).replace(/<tableParts.*<\/tableParts>/, ""), files));
    const sheet = workbook.sheets[0]!;
    const look = (row: number, col: number) => cellLook(workbook, sheet, row, col, workbook.styles.resolve(sheet.cells.get(cellKey(row, col))?.style ?? 0));
    return { workbook, sheet, look };
  };
  it("takes a white header's fill from its table, so it is visible", () => {
    const { look, workbook, sheet } = book(1, true);
    expect(look(0, 0)).toMatchObject({ fill: "#4472C4", color: "#FFFFFF", bold: true, unreadable: false });
    expect(unreadableCells(workbook, sheet)).toEqual({ count: 0, first: [] });
  });
  it("bands the body and bolds the first column from the table", () => {
    const { look } = book(1, true);
    expect(look(1, 0)).toMatchObject({ fill: lighten("#4472C4", 0.82), bold: true });
    expect(look(2, 1)).toMatchObject({ fill: null, bold: false });
    expect(look(1, 1).color).toBe("#000000");
  });
  it("lets a cell's own fill and colours win over the table", () => {
    const { look } = book(2, true);
    expect(look(0, 0)).toMatchObject({ fill: "#17365D", color: "#FFFFFF" });
  });
  it("shows white-on-nothing in readable ink and reports it, because Excel would show nothing either", () => {
    const { look, workbook, sheet } = book(1, false);
    expect(look(0, 0)).toMatchObject({ fill: null, unreadable: true, color: "#18181B" });
    expect(unreadableCells(workbook, sheet)).toEqual({ count: 2, first: ["A1", "B1"] });
  });
  it("draws empty cells inside a table's banding even though the file stores nothing for them", () => {
    const { look } = book(1, true);
    expect(look(3, 1)).toMatchObject({ fill: lighten("#4472C4", 0.82) });
  });
});
