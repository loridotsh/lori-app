/** Cell addresses. Rows and columns are 0-based inside the code; names are 1-based like Excel. */

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

export function colName(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" -> 0, "AA" -> 26. Returns -1 for anything that is not a column name within Excel's limits. */
export function colIndex(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return -1;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

export const cellName = (row: number, col: number): string => `${colName(col)}${row + 1}`;

export interface ParsedCell {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
}

export function parseCell(text: string): ParsedCell | null {
  const match = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(text);
  if (!match) return null;
  const col = colIndex(match[2]!);
  const row = Number(match[4]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col, absRow: match[3] === "$", absCol: match[1] === "$" };
}

export interface Bounds {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** "A1", "A1:C3" -> bounds, normalized so r1 <= r2 and c1 <= c2. */
export function parseRange(text: string): Bounds | null {
  const [first, second, ...rest] = text.split(":");
  if (rest.length || !first) return null;
  const a = parseCell(first);
  const b = second === undefined ? a : parseCell(second);
  if (!a || !b) return null;
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

export const key = (row: number, col: number): string => `${row},${col}`;
export function unkey(value: string): [number, number] {
  const at = value.indexOf(",");
  return [Number(value.slice(0, at)), Number(value.slice(at + 1))];
}
