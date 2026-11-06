/** What a cell really looks like: its own formatting, then its table's style, then a guard for unreadable text. */
import { cellName } from "./address";
import { contrast, readableOn, tableAt, tableLook, UNREADABLE_BELOW } from "./table-styles";
import { keyCol, keyRow, type Border, type ResolvedStyle, type SheetModel, type WorkbookModel } from "./workbook";

const INK = "#18181B";
const PAPER = "#FFFFFF";

export interface CellLook {
  fill: string | null;
  /** The text colour to draw with. Never one that cannot be told from the background. */
  color: string;
  bold: boolean;
  borderTop: Border | null;
  borderBottom: Border | null;
  /** The file asks for text that cannot be read against its background (white on white). */
  unreadable: boolean;
}

export function cellLook(workbook: WorkbookModel, sheet: SheetModel, row: number, col: number, style: ResolvedStyle): CellLook {
  const table = sheet.tables.length ? tableAt(sheet, row, col) : undefined;
  const fromTable = table ? tableLook(table, row, col, workbook.theme) : null;
  // A font colour left at the workbook's default does not override a table style's text colour.
  const normal = workbook.styles.resolve(0).color;
  const explicit = style.color && style.color !== normal ? style.color : null;
  const fill = style.fill ?? fromTable?.fill ?? null;
  const wanted = explicit ?? fromTable?.color ?? style.color ?? INK;
  const background = fill ?? PAPER;
  const unreadable = contrast(wanted, background) < UNREADABLE_BELOW;
  return {
    fill,
    color: unreadable ? readableOn(background) : wanted,
    bold: style.bold || !!fromTable?.bold,
    borderTop: style.border.top ?? fromTable?.borderTop ?? null,
    borderBottom: style.border.bottom ?? fromTable?.borderBottom ?? null,
    unreadable,
  };
}

/** Cells with something to read whose colours the file made invisible, for a note to the member. */
export function unreadableCells(workbook: WorkbookModel, sheet: SheetModel): { count: number; first: string[] } {
  let count = 0;
  const first: string[] = [];
  for (const [key, cell] of sheet.cells) {
    const shown = cell.value !== null && cell.value !== "" && typeof cell.value !== "boolean";
    if (!shown && cell.formula === undefined) continue;
    const row = keyRow(key);
    const col = keyCol(key);
    if (!cellLook(workbook, sheet, row, col, workbook.styles.resolve(cell.style)).unreadable) continue;
    count++;
    if (first.length < 3) first.push(cellName(row, col));
  }
  return { count, first };
}
