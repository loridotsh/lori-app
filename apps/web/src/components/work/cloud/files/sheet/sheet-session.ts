/** One open workbook being edited: its model, calculator, undo history and unsaved changes. */
import { Calculator, cellKey, inputText, lockedReason, parseInput, restoreCell, setInput, type Cell, type Input, type SheetModel, type WorkbookModel } from "./workbook";
import { readWorkbook, type ReadResult } from "./xlsx-read";
import { prepareSave, type Edits } from "./xlsx-write";

interface Change {
  sheet: SheetModel;
  row: number;
  col: number;
  before: Cell | undefined;
  after: Cell | undefined;
}

const MAX_HISTORY = 200;
const MAX_PASTE_CELLS = 50_000;

export interface Rect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Splits clipboard text the way spreadsheets write it: tabs between cells, newlines between rows, quotes around cells that contain either. */
export function parseTabular(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const normalized = text.replace(/\r\n?/g, "\n");
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (quoted) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
    i++;
  }
  // A trailing newline (as every copy ends with) does not add an empty row.
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function formatTabular(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join("\t")).join("\n");
}

export class SheetSession {
  readonly workbook: WorkbookModel;
  readonly calc: Calculator;
  readonly pkg: ReadResult["pkg"];
  private baseline: Uint8Array;
  /** Cells that differ from the stored file, with the edit number that last touched each. */
  private touched = new Map<SheetModel, Map<number, number>>();
  private sequence = 0;
  private history: Change[][] = [];
  private cursor = 0;
  private savedCursor = 0;
  private listeners = new Set<() => void>();
  private revision = 0;

  constructor(bytes: Uint8Array) {
    const read = readWorkbook(bytes);
    this.workbook = read.workbook;
    this.pkg = read.pkg;
    this.baseline = bytes;
    this.calc = new Calculator(this.workbook);
  }

  /* ------------------------------------------------------- subscription */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getRevision = (): number => this.revision;
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------- reading */
  get dirty(): boolean {
    return this.cursor !== this.savedCursor;
  }
  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.history.length;
  }

  cell(sheet: SheetModel, row: number, col: number): Cell | undefined {
    return sheet.cells.get(cellKey(row, col));
  }

  /** The text a member sees in the formula bar for a cell. */
  input(sheet: SheetModel, row: number, col: number): string {
    const cell = this.cell(sheet, row, col);
    return inputText(cell, this.workbook.date1904, this.workbook.styles.resolve(cell?.style ?? 0).numFmt);
  }

  lockedReason(sheet: SheetModel, row: number, col: number): string | null {
    return lockedReason(sheet, row, col);
  }

  /** Cells selected, as tab-separated text for the clipboard. */
  copyText(sheet: SheetModel, rect: Rect): string {
    const rows: string[][] = [];
    for (let r = rect.r1; r <= rect.r2; r++) {
      const line: string[] = [];
      for (let c = rect.c1; c <= rect.c2; c++) line.push(this.input(sheet, r, c));
      rows.push(line);
    }
    return formatTabular(rows);
  }

  /* ------------------------------------------------------------- editing */
  /** Remember that a cell differs from the file, so the next save rewrites it (including when an undo puts it back). */
  private touch(changes: Change[]) {
    this.sequence++;
    for (const change of changes) {
      const keys = this.touched.get(change.sheet) ?? new Map<number, number>();
      keys.set(cellKey(change.row, change.col), this.sequence);
      this.touched.set(change.sheet, keys);
    }
  }

  private record(changes: Change[]) {
    if (!changes.length) return;
    this.touch(changes);
    // A new edit ends any redo chain; a saved state that lay inside it can no longer be returned to.
    if (this.savedCursor > this.cursor) this.savedCursor = -1;
    this.history.length = this.cursor;
    this.history.push(changes);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
      this.savedCursor--;
    }
    this.cursor = this.history.length;
    this.changed();
  }

  /** Applies typed input to several cells as one undoable step. Returns why it was refused, if it was. */
  apply(sheet: SheetModel, entries: { row: number; col: number; text: string }[]): string | null {
    const changes: Change[] = [];
    for (const { row, col } of entries) {
      const locked = lockedReason(sheet, row, col);
      if (locked) return locked;
    }
    for (const { row, col, text } of entries) {
      const input: Input = parseInput(text, this.workbook.date1904);
      const before = sheet.cells.get(cellKey(row, col));
      setInput(this.calc, sheet, row, col, input);
      const after = sheet.cells.get(cellKey(row, col));
      if (before !== after) changes.push({ sheet, row, col, before, after });
    }
    this.record(changes);
    return null;
  }

  clear(sheet: SheetModel, rect: Rect): string | null {
    const entries: { row: number; col: number; text: string }[] = [];
    for (let r = rect.r1; r <= rect.r2; r++)
      for (let c = rect.c1; c <= rect.c2; c++) if (sheet.cells.get(cellKey(r, c))?.formula !== undefined || (sheet.cells.get(cellKey(r, c))?.value ?? null) !== null) entries.push({ row: r, col: c, text: "" });
    return entries.length ? this.apply(sheet, entries) : null;
  }

  /** Pastes tab-separated text with its top-left at (row, col). Returns an error message when it cannot. */
  paste(sheet: SheetModel, row: number, col: number, text: string): string | null {
    const grid = parseTabular(text);
    const cells = grid.reduce((total, line) => total + line.length, 0);
    if (cells > MAX_PASTE_CELLS) return "That is too much to paste at once. Paste fewer than 50,000 cells.";
    const entries: { row: number; col: number; text: string }[] = [];
    grid.forEach((line, dr) => line.forEach((value, dc) => entries.push({ row: row + dr, col: col + dc, text: value })));
    return entries.length ? this.apply(sheet, entries) : null;
  }

  undo(): void {
    if (!this.canUndo) return;
    const changes = this.history[--this.cursor]!;
    for (const change of [...changes].reverse()) restoreCell(this.calc, change.sheet, change.row, change.col, change.before);
    this.touch(changes);
    this.changed();
  }
  redo(): void {
    if (!this.canRedo) return;
    const changes = this.history[this.cursor++]!;
    for (const change of changes) restoreCell(this.calc, change.sheet, change.row, change.col, change.after);
    this.touch(changes);
    this.changed();
  }

  /* -------------------------------------------------------------- saving */
  /**
   * The workbook with every edit so far written into the original package. Nothing about the
   * session changes until markSaved(), so a failed upload can be retried, and edits made while
   * an upload is in flight are still counted as unsaved afterwards.
   */
  beginSave(): SaveTicket {
    const edits: Edits = { cells: new Map([...this.touched].map(([sheet, keys]) => [sheet, new Set(keys.keys())])) };
    const prepared = prepareSave(this.baseline, this.calc, edits);
    return { bytes: prepared.bytes, sequence: this.sequence, cursor: this.cursor, commit: prepared.commit };
  }

  /** Call once the ticket's bytes are stored: they become the new baseline. */
  markSaved(ticket: SaveTicket): void {
    ticket.commit();
    this.baseline = ticket.bytes;
    for (const [sheet, keys] of this.touched) {
      for (const [key, at] of keys) if (at <= ticket.sequence) keys.delete(key);
      if (!keys.size) this.touched.delete(sheet);
    }
    this.savedCursor = ticket.cursor;
    this.changed();
  }
}

export interface SaveTicket {
  bytes: Uint8Array;
  sequence: number;
  cursor: number;
  commit(): void;
}
