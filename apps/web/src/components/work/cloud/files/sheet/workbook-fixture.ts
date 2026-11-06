/** Builds small in-memory workbooks for tests: { Sheet1: { A1: 5, B1: "=A1*2" } }. */
import { parseCell } from "./address";
import { Calculator, cellKey, type Cell, type ResolvedStyle, type SheetModel, type StyleTable, type WorkbookModel } from "./workbook";
import type { Scalar } from "./values";

export const PLAIN_STYLE: ResolvedStyle = {
  numFmt: "General",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontSize: 11,
  fontName: "Arial",
  color: null,
  fill: null,
  border: { left: null, right: null, top: null, bottom: null },
  horizontal: null,
  vertical: null,
  wrap: false,
  indent: 0,
};

export function plainStyles(formats: string[] = []): StyleTable {
  const added: { base: number; numFmtId: number }[] = [];
  const codes = ["General", ...formats];
  return {
    resolve: (xf) => ({ ...PLAIN_STYLE, numFmt: codes[xf] ?? "General" }),
    numFmtId: () => 0,
    withNumFmt: (base, numFmtId) => {
      added.push({ base, numFmtId });
      codes.push(numFmtId === 9 ? "0%" : numFmtId === 14 ? "m/d/yyyy" : "General");
      return codes.length - 1;
    },
    added,
    commitAdded: (count) => {
      added.splice(0, count);
    },
    get count() {
      return codes.length;
    },
  };
}

export type Spec = Record<string, Record<string, Scalar | string>>;

export function emptySheet(name: string): SheetModel {
  return {
    name,
    part: `xl/worksheets/${name}.xml`,
    hidden: false,
    cells: new Map(),
    rows: 0,
    cols: 0,
    defaultColWidth: 8.43,
    defaultRowHeight: 15,
    colWidths: new Map(),
    rowHeights: new Map(),
    hiddenCols: new Set(),
    hiddenRows: new Set(),
    merges: [],
    arrays: [],
    tables: [],
    freezeRows: 0,
    freezeCols: 0,
    showGridLines: true,
    tabColor: null,
    drawings: 0,
  };
}

/** A string starting with "=" is a formula (its stored value is blank, like a file Excel never calculated). */
export function book(spec: Spec, options: { names?: Record<string, string>; date1904?: boolean; formats?: string[] } = {}): Calculator {
  const sheets: SheetModel[] = Object.entries(spec).map(([name, cells]) => {
    const sheet = emptySheet(name);
    for (const [address, raw] of Object.entries(cells)) {
      const at = parseCell(address)!;
      const cell: Cell = typeof raw === "string" && raw.startsWith("=") ? { value: null, formula: raw.slice(1), style: 0 } : { value: raw as Scalar, style: 0 };
      sheet.cells.set(cellKey(at.row, at.col), cell);
      sheet.rows = Math.max(sheet.rows, at.row + 1);
      sheet.cols = Math.max(sheet.cols, at.col + 1);
    }
    return sheet;
  });
  const workbook: WorkbookModel = {
    sheets,
    activeSheet: 0,
    theme: ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"],
    styles: plainStyles(options.formats),
    date1904: options.date1904 ?? false,
    definedNames: new Map(Object.entries(options.names ?? {})),
    customFormats: new Map(),
    unsupported: [],
  };
  const calc = new Calculator(workbook);
  calc.setClock(() => 46217.5);
  return calc;
}

/** The calculated value at an address on the first (or a named) sheet. */
export function at(calc: Calculator, address: string, sheet?: string): Scalar {
  const target = sheet ? calc.sheet(sheet)! : calc.workbook.sheets[0]!;
  const cell = parseCell(address)!;
  return calc.value(target, cell.row, cell.col);
}
