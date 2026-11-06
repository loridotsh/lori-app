export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 50;

export interface Table {
  rows: string[][];
  /** The data had more rows or columns than are shown. */
  clipped: boolean;
}

/**
 * Parses delimited text (RFC 4180 quoting) for a read-only grid. Stops after
 * the rows and columns that will be shown, so a huge file costs no more than a
 * small one.
 */
export function parseDelimited(
  text: string,
  delimiter = ",",
  maxRows = MAX_TABLE_ROWS,
  maxColumns = MAX_TABLE_COLUMNS,
): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let clipped = false;
  let started = false;
  const endCell = () => {
    if (row.length < maxColumns) row.push(cell);
    else clipped = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    started = false;
  };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index++) {
    if (rows.length >= maxRows) {
      clipped = true;
      break;
    }
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      started = true;
    } else if (char === delimiter) {
      started = true;
      endCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      endRow();
    } else {
      started = true;
      cell += char;
    }
  }
  if (rows.length < maxRows && (started || cell !== "" || row.length)) endRow();
  return { rows, clipped };
}
