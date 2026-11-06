/**
 * Moves the relative references in formula text, as filling a formula down or right does.
 * Used to expand shared formulas, which store one formula for a whole block of cells.
 */
import { colIndex, colName, MAX_COLS, MAX_ROWS } from "./address";

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const COLUMN = /^(\$?)([A-Za-z]{1,3})$/;
const ROW = /^(\$?)(\d{1,7})$/;

function shiftCell(token: string, dr: number, dc: number): string | null {
  const match = CELL.exec(token);
  if (!match) return null;
  const col = colIndex(match[2]!);
  if (col < 0) return null;
  const row = Number(match[4]) - 1;
  const nextCol = match[1] ? col : col + dc;
  const nextRow = match[3] ? row : row + dr;
  if (nextCol < 0 || nextCol >= MAX_COLS || nextRow < 0 || nextRow >= MAX_ROWS) return "#REF!";
  return `${match[1]}${colName(nextCol)}${match[3]}${nextRow + 1}`;
}

export function shiftFormula(source: string, dr: number, dc: number): string {
  if (!dr && !dc) return source;
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === ch) {
          if (source[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.$]/.test(source[j]!)) j++;
      const token = source.slice(i, j);
      const after = source[j];
      const before = source[i - 1];
      if (after === "(" || after === "!") {
        // A function name, or a sheet name such as Q1 in Q1!A1.
        out += token;
      } else {
        const cell = shiftCell(token, dr, dc);
        if (cell !== null) out += cell;
        else {
          // Whole-column (A:A) and whole-row (1:1) references.
          const column = COLUMN.exec(token);
          const row = ROW.exec(token);
          const partner = after === ":" ? /^[$A-Za-z0-9]+/.exec(source.slice(j + 1))?.[0] : before === ":" ? /[$A-Za-z0-9]+$/.exec(source.slice(0, i - 1))?.[0] : undefined;
          if (column && partner && COLUMN.test(partner) && (after === ":" || before === ":")) {
            const col = colIndex(column[2]!);
            const next = column[1] ? col : col + dc;
            out += next < 0 || next >= MAX_COLS ? "#REF!" : `${column[1]}${colName(next)}`;
          } else if (row && partner && ROW.test(partner)) {
            const value = Number(row[2]) - 1;
            const next = row[1] ? value : value + dr;
            out += next < 0 || next >= MAX_ROWS ? "#REF!" : `${row[1]}${next + 1}`;
          } else out += token;
        }
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
