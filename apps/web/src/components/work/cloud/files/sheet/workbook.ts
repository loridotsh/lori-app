/** The in-memory workbook: sheets, cells, styles, and a lazy memoized calculator. */
import { MAX_COLS, type Bounds } from "./address";
import { evaluateCell } from "./evaluate";
import { UnsupportedFunction, type Env } from "./eval-types";
import { formatValue, isDateFormat, resolveFormatCode, type Formatted } from "./numfmt";
import { FormulaSyntaxError, parseFormula, type Node } from "./parser";
import { dateToSerial, ERRORS, isErrorCode, parseNumeric, type Scalar } from "./values";

export const cellKey = (row: number, col: number): number => row * MAX_COLS + col;
export const keyRow = (key: number): number => Math.floor(key / MAX_COLS);
export const keyCol = (key: number): number => key % MAX_COLS;

export interface Cell {
  /** The literal value, or for a formula the last value that was calculated (as stored in the file). */
  value: Scalar;
  /** The formula without its leading "=". */
  formula?: string;
  style: number;
  /** Shared-formula group this cell came from, so the writer can keep or unshare it. */
  shared?: number;
  /** An array formula: the file's values are kept, since results spill into other cells. */
  array?: boolean;
}

export interface Border {
  style: string;
  color: string;
}
export interface ResolvedStyle {
  numFmt: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number;
  fontName: string;
  color: string | null;
  fill: string | null;
  border: { left: Border | null; right: Border | null; top: Border | null; bottom: Border | null };
  horizontal: string | null;
  vertical: string | null;
  wrap: boolean;
  indent: number;
}

export interface StyleTable {
  /** Resolved visual style for a cellXfs index. */
  resolve(xf: number): ResolvedStyle;
  /** Number format id used by a cellXfs index. */
  numFmtId(xf: number): number;
  /** The index of a style like `xf` but with a different number format. New styles are recorded for the writer. */
  withNumFmt(xf: number, numFmtId: number): number;
  /** Styles added since the last save, in order: the style each was copied from and its number format. */
  readonly added: { base: number; numFmtId: number }[];
  /** The first `count` added styles now exist in the saved file. */
  commitAdded(count: number): void;
  readonly count: number;
}

/** An Excel table: a block that takes its header, banding and totals look from a named table style. */
export interface TableModel {
  bounds: Bounds;
  hasHeader: boolean;
  hasTotals: boolean;
  /** For example "TableStyleMedium2"; null for a table with no style. */
  style: string | null;
  firstColumn: boolean;
  lastColumn: boolean;
  rowStripes: boolean;
  columnStripes: boolean;
}

export interface SheetModel {
  name: string;
  /** The part name inside the package, such as xl/worksheets/sheet1.xml. */
  part: string;
  hidden: boolean;
  cells: Map<number, Cell>;
  /** Used extent, as counts. */
  rows: number;
  cols: number;
  defaultColWidth: number;
  defaultRowHeight: number;
  colWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenCols: Set<number>;
  hiddenRows: Set<number>;
  merges: Bounds[];
  /** Ranges owned by array formulas. Their cells are calculated together and not editable one by one. */
  arrays: Bounds[];
  tables: TableModel[];
  freezeRows: number;
  freezeCols: number;
  showGridLines: boolean;
  tabColor: string | null;
  /** Charts, images or shapes the grid cannot draw; they stay intact in the file. */
  drawings: number;
}

export interface WorkbookModel {
  sheets: SheetModel[];
  /** Index into `sheets` of the tab the file was saved on. */
  activeSheet: number;
  /** Theme colours as hex, indexed like spreadsheet theme indexes (4-9 are the six accents). */
  theme: string[];
  styles: StyleTable;
  date1904: boolean;
  definedNames: Map<string, string>;
  customFormats: Map<number, string>;
  /** Parts of the package this model does not render (charts, pivot tables, macros). */
  unsupported: string[];
}

export type Input =
  | { kind: "blank" }
  | { kind: "value"; value: Scalar; numFmtId?: number }
  | { kind: "formula"; formula: string };

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * What typing `text` into a cell means, the way Excel reads it: a leading = is a formula, a leading '
 * forces text, and numbers, percentages, booleans and plain dates become typed values.
 */
export function parseInput(text: string, date1904 = false): Input {
  if (text === "") return { kind: "blank" };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", formula: text.slice(1) };
  if (text.startsWith("'")) return { kind: "value", value: text.slice(1) };
  const trimmed = text.trim();
  if (/^true$/i.test(trimmed)) return { kind: "value", value: true };
  if (/^false$/i.test(trimmed)) return { kind: "value", value: false };
  if (isErrorCode(trimmed.toUpperCase())) return { kind: "value", value: ERRORS[trimmed.toUpperCase() as keyof typeof ERRORS] };
  const numeric = parseNumeric(trimmed);
  if (numeric !== null) return { kind: "value", value: numeric, numFmtId: trimmed.endsWith("%") ? 9 : undefined };
  const iso = ISO_DATE.exec(trimmed);
  const us = US_DATE.exec(trimmed);
  const parts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : us ? [Number(us[3]), Number(us[1]), Number(us[2])] : null;
  if (parts) {
    const [year, month, day] = parts as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day)
      return { kind: "value", value: dateToSerial(date, date1904), numFmtId: 14 };
  }
  return { kind: "value", value: text };
}

/** What a cell shows in the formula bar: its formula, or its value as typed. */
export function inputText(cell: Cell | undefined, date1904: boolean, format: string): string {
  if (!cell) return "";
  if (cell.formula !== undefined) return `=${cell.formula}`;
  const value = cell.value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (isDateFormat(format) && value >= 1) return formatValue(value, Number.isInteger(value) ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm:ss", date1904).text;
    return String(Number(value.toPrecision(15)));
  }
  if (typeof value === "string") {
    // Text that would be read back as something else needs the leading ' that forces text.
    const parsed = parseInput(value, date1904);
    return parsed.kind === "value" && parsed.value === value ? value : `'${value}`;
  }
  return value.code;
}

export interface CalcStats {
  /** Formulas whose function this engine does not implement; they keep the values stored in the file. */
  approximate: number;
  circular: boolean;
  /** Names of the functions behind those formulas. */
  unsupported: string[];
}

/** Calculates formulas on demand and remembers the results until a cell changes. */
export class Calculator {
  private readonly memo = new Map<SheetModel, Map<number, Scalar>>();
  private readonly parsed = new WeakMap<Cell, Node | null>();
  private readonly names = new Map<string, Node | null>();
  private readonly active = new Set<Cell>();
  private readonly approximateCells = new Set<Cell>();
  private readonly unsupportedNames = new Set<string>();
  private circularSeen = false;
  private clock: () => number = () => dateToSerial(new Date(), false);

  constructor(readonly workbook: WorkbookModel) {}

  sheet(name: string): SheetModel | undefined {
    const lower = name.toLowerCase();
    return this.workbook.sheets.find((sheet) => sheet.name.toLowerCase() === lower);
  }

  /** Forget every calculated value. Call after any edit. */
  invalidate(): void {
    this.memo.clear();
    this.approximateCells.clear();
    this.circularSeen = false;
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  private nameNode(name: string): Node | undefined {
    const lower = name.toLowerCase();
    if (!this.names.has(lower)) {
      const source = [...this.workbook.definedNames].find(([key]) => key.toLowerCase() === lower)?.[1];
      let node: Node | null = null;
      if (source !== undefined) {
        try {
          node = parseFormula(source);
        } catch {
          node = null;
        }
      }
      this.names.set(lower, node);
    }
    return this.names.get(lower) ?? undefined;
  }

  private env(sheet: SheetModel, row: number, col: number): Env {
    return {
      sheet: sheet.name,
      row,
      col,
      cell: (name, r, c) => {
        const target = name === sheet.name ? sheet : this.sheet(name);
        return target ? this.value(target, r, c) : ERRORS["#REF!"];
      },
      extent: (name) => {
        const target = this.sheet(name);
        return target ? { rows: target.rows, cols: target.cols } : null;
      },
      name: (name) => this.nameNode(name),
      date1904: this.workbook.date1904,
      now: this.clock,
    };
  }

  private ast(cell: Cell): Node | null {
    if (this.parsed.has(cell)) return this.parsed.get(cell) ?? null;
    let node: Node | null = null;
    try {
      node = parseFormula(cell.formula!);
    } catch (error) {
      if (!(error instanceof FormulaSyntaxError)) throw error;
    }
    this.parsed.set(cell, node);
    return node;
  }

  value(sheet: SheetModel, row: number, col: number): Scalar {
    const cell = sheet.cells.get(cellKey(row, col));
    if (!cell) return null;
    if (cell.formula === undefined) return cell.value;
    let results = this.memo.get(sheet);
    if (!results) this.memo.set(sheet, (results = new Map()));
    const key = cellKey(row, col);
    if (results.has(key)) return results.get(key)!;
    if (cell.array) {
      results.set(key, cell.value);
      this.approximateCells.add(cell);
      return cell.value;
    }
    if (this.active.has(cell)) {
      this.circularSeen = true;
      return 0;
    }
    const node = this.ast(cell);
    let result: Scalar;
    if (!node) {
      result = cell.value;
      this.approximateCells.add(cell);
    } else {
      this.active.add(cell);
      try {
        result = evaluateCell(node, this.env(sheet, row, col));
      } catch (error) {
        if (!(error instanceof UnsupportedFunction)) throw error;
        result = cell.value;
        this.approximateCells.add(cell);
        this.unsupportedNames.add(error.fn);
      } finally {
        this.active.delete(cell);
      }
    }
    results.set(key, result);
    return result;
  }

  format(sheet: SheetModel, row: number, col: number): Formatted {
    const cell = sheet.cells.get(cellKey(row, col));
    if (!cell) return { text: "", isText: false };
    const code = this.workbook.styles.resolve(cell.style).numFmt;
    return formatValue(this.value(sheet, row, col), code, this.workbook.date1904);
  }

  /** Every formula in the workbook, calculated; returns the cells whose value now differs from the stored one. */
  recalculateAll(): { sheet: SheetModel; row: number; col: number; value: Scalar }[] {
    const changed: { sheet: SheetModel; row: number; col: number; value: Scalar }[] = [];
    for (const sheet of this.workbook.sheets) {
      for (const [key, cell] of sheet.cells) {
        if (cell.formula === undefined) continue;
        const row = keyRow(key);
        const col = keyCol(key);
        const value = this.value(sheet, row, col);
        if (!sameValue(value, cell.value)) changed.push({ sheet, row, col, value });
      }
    }
    return changed;
  }

  /** Adopt calculated values as the stored ones, after they have been written to the file. */
  commit(changed: { sheet: SheetModel; row: number; col: number; value: Scalar }[]): void {
    for (const { sheet, row, col, value } of changed) {
      const cell = sheet.cells.get(cellKey(row, col));
      if (cell) cell.value = value;
    }
  }

  stats(): CalcStats {
    return { approximate: this.approximateCells.size, circular: this.circularSeen, unsupported: [...this.unsupportedNames].sort() };
  }
}

export function sameValue(a: Scalar, b: Scalar): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) return a.code === b.code;
  return a === b;
}

/** Why a cell cannot be edited here, or null when it can. */
export function lockedReason(sheet: SheetModel, row: number, col: number): string | null {
  if (sheet.arrays.some((range) => row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2))
    return "This cell belongs to an array formula. Edit it in Excel, where the whole array can be changed together.";
  return null;
}

/** Edits a cell from typed input. Returns the previous cell so the caller can undo. */
export function setInput(calc: Calculator, sheet: SheetModel, row: number, col: number, input: Input): Cell | undefined {
  const key = cellKey(row, col);
  const previous = sheet.cells.get(key);
  const style = previous?.style ?? 0;
  if (input.kind === "blank") {
    // Keep the cell when it carries a style, so formatting survives clearing its content.
    if (previous?.style) sheet.cells.set(key, { value: null, style: previous.style });
    else sheet.cells.delete(key);
  } else if (input.kind === "formula") {
    sheet.cells.set(key, { value: previous?.value ?? null, formula: input.formula, style });
  } else {
    const format = calc.workbook.styles.resolve(style).numFmt;
    let next = style;
    if (input.numFmtId !== undefined && /^general$/i.test(format)) next = calc.workbook.styles.withNumFmt(style, input.numFmtId);
    sheet.cells.set(key, { value: input.value, style: next });
  }
  if (input.kind !== "blank" || previous) {
    sheet.rows = Math.max(sheet.rows, row + 1);
    sheet.cols = Math.max(sheet.cols, col + 1);
  }
  calc.invalidate();
  return previous;
}

/** Puts a cell back as it was (or removes it), for undo. */
export function restoreCell(calc: Calculator, sheet: SheetModel, row: number, col: number, previous: Cell | undefined): void {
  const key = cellKey(row, col);
  if (previous) sheet.cells.set(key, previous);
  else sheet.cells.delete(key);
  calc.invalidate();
}

export { resolveFormatCode };
