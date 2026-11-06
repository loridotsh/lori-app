/** Reads an .xlsx package into a WorkbookModel. Nothing here executes content from the file. */
import { unzipSync } from "fflate";
import { MAX_COLS, MAX_ROWS, parseCell, parseRange } from "./address";
import { childrenNamed, descendants, prefixedAttribute } from "./dom";
import { shiftFormula } from "./formula-shift";
import { scan, XmlSyntaxError, type Tag } from "./sax";
import { Styles, parseTheme } from "./styles";
import { dateToSerial, ERRORS, isErrorCode, type Scalar } from "./values";
import { cellKey, type Cell, type SheetModel, type TableModel, type WorkbookModel } from "./workbook";

export type ReadFailure = "too_large" | "not_workbook" | "encrypted" | "corrupt";
export class WorkbookReadError extends Error {
  constructor(
    readonly reason: ReadFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Limits that keep a hostile or enormous file from exhausting the browser tab. */
export const LIMITS = {
  /** Total uncompressed size of every part. */
  uncompressedBytes: 256 * 1024 * 1024,
  /** A single worksheet part. */
  sheetBytes: 64 * 1024 * 1024,
  cells: 600_000,
  sheets: 64,
};

const decoder = new TextDecoder("utf-8");

function parseSmallXml(bytes: Uint8Array | undefined, what: string): Document {
  if (!bytes) throw new WorkbookReadError("not_workbook", `The file has no ${what}.`);
  const doc = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new WorkbookReadError("corrupt", `The ${what} could not be read.`);
  return doc;
}

function relationshipTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function readSharedStrings(bytes: Uint8Array | undefined): string[] {
  if (!bytes) return [];
  const strings: string[] = [];
  let current = "";
  let inItem = false;
  const path: string[] = [];
  try {
    for (const token of scan(decoder.decode(bytes))) {
      if (token.kind === "text") {
        // Text of rich runs is joined; phonetic hints (rPh) are not part of the string.
        if (inItem && path[path.length - 1] === "t" && !path.includes("rPh")) current += token.text;
        continue;
      }
      if (token.kind === "close") {
        if (path.pop() !== token.name) throw new XmlSyntaxError("Mismatched tags");
        if (token.name === "si") {
          strings.push(current);
          inItem = false;
        }
        continue;
      }
      if (token.name === "si") {
        inItem = true;
        current = "";
        if (token.kind === "self") {
          strings.push("");
          inItem = false;
          continue;
        }
      }
      if (token.kind === "open") path.push(token.name);
    }
    if (path.length) throw new XmlSyntaxError("Unclosed tags");
  } catch (error) {
    if (error instanceof XmlSyntaxError) throw new WorkbookReadError("corrupt", "The shared strings could not be read.");
    throw error;
  }
  return strings;
}

export interface Package {
  /** Every entry of the zip, in order, with its uncompressed size. */
  entries: { name: string; size: number }[];
}

export interface ReadResult {
  workbook: WorkbookModel;
  pkg: Package;
}

interface PendingCell {
  row: number;
  col: number;
  style: number;
  type: string | null;
  v: string;
  hasValue: boolean;
  inline: string;
  formula: { text: string; attrs: Record<string, string> } | null;
}

function decodeValue(pending: PendingCell, strings: string[]): Scalar {
  const raw = pending.v;
  switch (pending.type) {
    case "s": {
      const index = Number(raw);
      return Number.isInteger(index) && index >= 0 && index < strings.length ? strings[index]! : null;
    }
    case "str":
      return raw;
    case "inlineStr":
      return pending.inline;
    case "b":
      return raw === "1" || raw === "true";
    case "e": {
      const code = raw.toUpperCase();
      return isErrorCode(code) ? ERRORS[code] : ERRORS["#VALUE!"];
    }
    case "d": {
      const date = raw ? new Date(raw) : null;
      return date && !Number.isNaN(date.getTime()) ? dateToSerial(date) : null;
    }
    default: {
      if (!pending.hasValue || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
  }
}

const truthy = (value: string | undefined): boolean => value === "1" || value === "true";

export function emptySheetModel(name: string, part: string, hidden: boolean): SheetModel {
  return {
    name,
    part,
    hidden,
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

function readSheet(xml: string, name: string, part: string, hidden: boolean, strings: string[], budget: { cells: number }): SheetModel {
  const sheet = emptySheetModel(name, part, hidden);
  const sharedMasters = new Map<number, { formula: string; row: number; col: number }>();
  const path: string[] = [];
  let seenView = false;
  let row = -1;
  let nextRow = 0;
  let nextCol = 0;
  let pending: PendingCell | null = null;

  const finishCell = (cell: PendingCell) => {
    const value = decodeValue(cell, strings);
    const model: Cell = { value, style: cell.style };
    const formula = cell.formula;
    if (formula) {
      const text = formula.text;
      if (formula.attrs.t === "shared") {
        const si = Number(formula.attrs.si);
        model.shared = si;
        if (text) {
          sharedMasters.set(si, { formula: text, row: cell.row, col: cell.col });
          model.formula = text;
        } else {
          const master = sharedMasters.get(si);
          if (master) model.formula = shiftFormula(master.formula, cell.row - master.row, cell.col - master.col);
        }
      } else if (text) {
        model.formula = text;
        if (formula.attrs.t === "array") {
          model.array = true;
          const range = parseRange(formula.attrs.ref ?? "") ?? { r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col };
          sheet.arrays.push(range);
        }
      }
    }
    if (value === null && model.formula === undefined && !cell.style) return;
    if (++budget.cells > LIMITS.cells) throw new WorkbookReadError("too_large", "This workbook has too many cells to open here.");
    sheet.cells.set(cellKey(cell.row, cell.col), model);
    sheet.rows = Math.max(sheet.rows, cell.row + 1);
    sheet.cols = Math.max(sheet.cols, cell.col + 1);
  };

  const startCell = (tag: Tag): PendingCell | null => {
    const parsed = tag.attrs.r ? parseCell(tag.attrs.r) : null;
    const col = parsed ? parsed.col : nextCol;
    nextCol = col + 1;
    if (col >= MAX_COLS || row < 0 || row >= MAX_ROWS) return null;
    return { row, col, style: Number(tag.attrs.s) || 0, type: tag.attrs.t ?? null, v: "", hasValue: false, inline: "", formula: null };
  };

  try {
    for (const token of scan(xml)) {
      if (token.kind === "text") {
        if (!pending) continue;
        const top = path[path.length - 1];
        if (top === "v") {
          pending.v += token.text;
          pending.hasValue = true;
        } else if (top === "f" && pending.formula) pending.formula.text += token.text;
        else if (top === "t" && !path.includes("rPh")) pending.inline += token.text;
        continue;
      }
      if (token.kind === "close") {
        if (path.pop() !== token.name) throw new XmlSyntaxError("Mismatched tags");
        if (token.name === "c" && pending) {
          finishCell(pending);
          pending = null;
        }
        continue;
      }
      const atRoot = path.length === 1;
      switch (token.name) {
        case "sheetFormatPr":
          sheet.defaultColWidth = Number(token.attrs.defaultColWidth) || (Number(token.attrs.baseColWidth) ? Number(token.attrs.baseColWidth) + 0.71 : 8.43);
          sheet.defaultRowHeight = Number(token.attrs.defaultRowHeight) || 15;
          break;
        case "sheetView":
          if (!seenView) {
            seenView = true;
            if (token.attrs.showGridLines === "0" || token.attrs.showGridLines === "false") sheet.showGridLines = false;
          }
          break;
        case "pane":
          if (/^frozen/.test(token.attrs.state ?? "")) {
            sheet.freezeCols = Math.max(0, Math.floor(Number(token.attrs.xSplit) || 0));
            sheet.freezeRows = Math.max(0, Math.floor(Number(token.attrs.ySplit) || 0));
          }
          break;
        case "tabColor":
          if (token.attrs.rgb && /^[0-9A-Fa-f]{8}$/.test(token.attrs.rgb)) sheet.tabColor = `#${token.attrs.rgb.slice(2)}`;
          break;
        case "col": {
          const min = Math.max(1, Number(token.attrs.min) || 1) - 1;
          const max = Math.min(MAX_COLS, Number(token.attrs.max) || min + 1) - 1;
          const width = Number(token.attrs.width);
          const isHidden = truthy(token.attrs.hidden);
          // A <col> spanning the whole sheet sets the default, not 16,384 entries.
          if (max - min > 2000) {
            if (width) sheet.defaultColWidth = width;
            break;
          }
          for (let c = min; c <= max; c++) {
            if (width) sheet.colWidths.set(c, width);
            if (isHidden) sheet.hiddenCols.add(c);
          }
          break;
        }
        case "row": {
          const declared = Number(token.attrs.r);
          row = Number.isInteger(declared) && declared >= 1 ? declared - 1 : nextRow;
          nextRow = row + 1;
          nextCol = 0;
          if (row < MAX_ROWS) {
            const height = Number(token.attrs.ht);
            if (height && truthy(token.attrs.customHeight)) sheet.rowHeights.set(row, height);
            if (truthy(token.attrs.hidden)) sheet.hiddenRows.add(row);
          }
          break;
        }
        case "c":
          pending = startCell(token);
          if (token.kind === "self" && pending) {
            finishCell(pending);
            pending = null;
          }
          // A cell outside the sheet's limits is skipped, together with its children.
          break;
        case "f":
          if (pending) {
            pending.formula = { text: "", attrs: token.attrs };
          }
          break;
        case "mergeCell": {
          const bounds = parseRange(token.attrs.ref ?? "");
          if (bounds && (bounds.r2 > bounds.r1 || bounds.c2 > bounds.c1)) {
            sheet.merges.push(bounds);
            sheet.rows = Math.max(sheet.rows, bounds.r2 + 1);
            sheet.cols = Math.max(sheet.cols, bounds.c2 + 1);
          }
          break;
        }
        case "drawing":
        case "legacyDrawing":
        case "picture":
          if (atRoot) sheet.drawings++;
          break;
      }
      if (token.kind === "open") path.push(token.name);
    }
    if (path.length) throw new XmlSyntaxError("Unclosed tags");
  } catch (error) {
    if (error instanceof XmlSyntaxError) throw new WorkbookReadError("corrupt", `The sheet ${name} could not be read.`);
    throw error;
  }
  return sheet;
}

/** The Excel tables attached to a sheet, found through the sheet's relationships. Anything unreadable is skipped. */
function readTables(files: Record<string, Uint8Array>, sheetPart: string): TableModel[] {
  const relsPath = sheetPart.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = files[relsPath];
  if (!rels) return [];
  const tables: TableModel[] = [];
  try {
    const doc = parseSmallXml(rels, "sheet relationships");
    for (const rel of descendants(doc, "Relationship")) {
      const target = rel.getAttribute("Target");
      if (!target || !/\/table$/.test(rel.getAttribute("Type") ?? "")) continue;
      const bytes = files[relationshipTarget(sheetPart, target)];
      if (!bytes) continue;
      const root = parseSmallXml(bytes, "table").documentElement;
      const bounds = parseRange(root.getAttribute("ref") ?? "");
      if (!bounds) continue;
      const info = descendants(root, "tableStyleInfo")[0];
      tables.push({
        bounds,
        hasHeader: root.getAttribute("headerRowCount") !== "0",
        hasTotals: Number(root.getAttribute("totalsRowCount")) > 0,
        style: info?.getAttribute("name") ?? null,
        firstColumn: truthy(info?.getAttribute("showFirstColumn") ?? undefined),
        lastColumn: truthy(info?.getAttribute("showLastColumn") ?? undefined),
        rowStripes: truthy(info?.getAttribute("showRowStripes") ?? undefined),
        columnStripes: truthy(info?.getAttribute("showColumnStripes") ?? undefined),
      });
    }
  } catch (error) {
    // A table's look is decoration; the data is still shown without it.
    if (!(error instanceof WorkbookReadError)) throw error;
  }
  return tables;
}

export function readWorkbook(input: Uint8Array): ReadResult {
  if (input.length < 4 || input[0] !== 0x50 || input[1] !== 0x4b) {
    // Password-protected workbooks are OLE containers, not zips.
    if (input[0] === 0xd0 && input[1] === 0xcf) throw new WorkbookReadError("encrypted", "This workbook is password-protected or in an old format.");
    throw new WorkbookReadError("not_workbook", "This is not an .xlsx workbook.");
  }
  const entries: Package["entries"] = [];
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(input, {
      filter(file) {
        total += file.originalSize;
        entries.push({ name: file.name, size: file.originalSize });
        if (total > LIMITS.uncompressedBytes) throw new WorkbookReadError("too_large", "This workbook is too large to open here.");
        if (/^xl\/worksheets\/[^/]+\.xml$/.test(file.name) && file.originalSize > LIMITS.sheetBytes) throw new WorkbookReadError("too_large", "A sheet in this workbook is too large to open here.");
        return /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|theme\/theme1\.xml|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.rels|tables\/[^/]+\.xml)$/.test(file.name);
      },
    });
  } catch (error) {
    if (error instanceof WorkbookReadError) throw error;
    throw new WorkbookReadError("corrupt", "This workbook could not be opened. The file may be damaged.");
  }
  const book = parseSmallXml(files["xl/workbook.xml"], "workbook");
  const relationships = new Map<string, string>();
  const relsDoc = files["xl/_rels/workbook.xml.rels"] ? parseSmallXml(files["xl/_rels/workbook.xml.rels"], "relationships") : null;
  if (relsDoc)
    for (const rel of descendants(relsDoc, "Relationship")) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) relationships.set(id, relationshipTarget("xl/workbook.xml", target));
    }

  const strings = readSharedStrings(files["xl/sharedStrings.xml"]);
  const theme = parseTheme(files["xl/theme/theme1.xml"] ? decoder.decode(files["xl/theme/theme1.xml"]) : undefined);
  const styles = new Styles(files["xl/styles.xml"] ? decoder.decode(files["xl/styles.xml"]) : undefined, theme);
  const date1904 = ["1", "true"].includes(descendants(book, "workbookPr")[0]?.getAttribute("date1904") ?? "");

  const budget = { cells: 0 };
  const sheets: SheetModel[] = [];
  const sheetElements = descendants(book, "sheet");
  if (sheetElements.length > LIMITS.sheets) throw new WorkbookReadError("too_large", "This workbook has too many sheets to open here.");
  for (const element of sheetElements) {
    const id = prefixedAttribute(element, "id");
    const target = id ? relationships.get(id) : undefined;
    const bytes = target ? files[target] : undefined;
    // Chart sheets and dialog sheets have no cells to show.
    if (!target || !bytes) continue;
    const state = element.getAttribute("state");
    const sheetName = element.getAttribute("name") ?? `Sheet${sheets.length + 1}`;
    const model = readSheet(decoder.decode(bytes), sheetName, target, state === "hidden" || state === "veryHidden", strings, budget);
    model.tables = readTables(files, target);
    sheets.push(model);
  }
  if (!sheets.length) throw new WorkbookReadError("not_workbook", "This workbook has no sheets to show.");

  const definedNames = new Map<string, string>();
  for (const name of childrenNamed(descendants(book, "definedNames")[0], "definedName")) {
    const key = name.getAttribute("name");
    // Names scoped to one sheet are not resolved; workbook-level names are.
    if (key && name.getAttribute("localSheetId") === null && name.textContent) definedNames.set(key, name.textContent);
  }
  const unsupported: string[] = [];
  const has = (pattern: RegExp) => entries.some((entry) => pattern.test(entry.name));
  if (has(/^xl\/vbaProject\.bin$/)) unsupported.push("macros");
  if (has(/^xl\/pivotTables\//)) unsupported.push("pivot tables");
  if (has(/^xl\/externalLinks\//)) unsupported.push("links to other workbooks");

  const tab = Number(descendants(book, "workbookView")[0]?.getAttribute("activeTab"));
  // The tab index counts every sheet in the file, including chart sheets this view skips.
  const activeName = Number.isInteger(tab) ? descendants(book, "sheet")[tab]?.getAttribute("name") : undefined;
  const activeSheet = Math.max(0, sheets.findIndex((sheet) => sheet.name === activeName));

  return {
    workbook: { sheets, activeSheet, theme: theme.colors, styles, date1904, definedNames, customFormats: styles.custom, unsupported },
    pkg: { entries },
  };
}
