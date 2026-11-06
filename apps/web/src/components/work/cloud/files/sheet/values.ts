/** Spreadsheet values and the coercions Excel applies between them. */

export type ErrorCode = "#NULL!" | "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#NUM!" | "#N/A";

export class CellError {
  constructor(readonly code: ErrorCode) {}
  toString(): string {
    return this.code;
  }
}

export const ERRORS: Record<ErrorCode, CellError> = {
  "#NULL!": new CellError("#NULL!"),
  "#DIV/0!": new CellError("#DIV/0!"),
  "#VALUE!": new CellError("#VALUE!"),
  "#REF!": new CellError("#REF!"),
  "#NAME?": new CellError("#NAME?"),
  "#NUM!": new CellError("#NUM!"),
  "#N/A": new CellError("#N/A"),
};
export const isErrorCode = (value: string): value is ErrorCode => value in ERRORS;

/** A blank cell is null. */
export type Scalar = number | string | boolean | CellError | null;
export type Matrix = Scalar[][];

export const isError = (value: unknown): value is CellError => value instanceof CellError;

/** Excel's General format for a number: up to 15 significant digits, E notation when very large or small. */
export function numberToText(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-9) {
    const [mantissa, exponent] = value.toExponential(14).split("e");
    const trimmed = mantissa!.replace(/\.?0+$/, "");
    const sign = exponent!.startsWith("-") ? "-" : "+";
    return `${trimmed}E${sign}${exponent!.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(Number(value.toPrecision(15)));
}

export function toText(value: Scalar): string | CellError {
  if (isError(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return numberToText(value);
  return value;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Text that Excel would accept as a number: "12", "1,200.5", "$3", "50%", " 7 ". */
export function parseNumeric(text: string): number | null {
  let body = text.trim();
  if (!body) return null;
  let percent = false;
  if (body.endsWith("%")) {
    percent = true;
    body = body.slice(0, -1).trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  body = body.replace(/^([+-]?)\$/, "$1");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(body)) body = body.replace(/,/g, "");
  if (!NUMERIC.test(body)) return null;
  const parsed = Number(body);
  if (!Number.isFinite(parsed)) return null;
  const result = percent ? parsed / 100 : parsed;
  return negative ? -result : result;
}

export function toNumber(value: Scalar): number | CellError {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = parseNumeric(value);
  return parsed === null ? ERRORS["#VALUE!"] : parsed;
}

export function toBoolean(value: Scalar): boolean | CellError {
  if (isError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return ERRORS["#VALUE!"];
}

const rank = (value: Scalar): number => (typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);

/** Excel's ordering: numbers, then text (case-insensitive), then booleans. Blanks take the type of the other side. */
export function compareScalars(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const x = a as number | string | boolean;
  const y = b as number | string | boolean;
  if (rank(x) !== rank(y)) return rank(x) < rank(y) ? -1 : 1;
  if (typeof x === "string" && typeof y === "string") {
    const left = x.toLowerCase();
    const right = y.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const left = Number(x);
  const right = Number(y);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Dates are serial numbers: days since 1899-12-30 (1900 system) or 1904-01-01. */
const DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

export function serialToDate(serial: number, date1904 = false): Date {
  // Excel treats 1900 as a leap year: serial 60 is the non-existent 1900-02-29.
  const adjusted = !date1904 && serial < 60 ? serial + 1 : serial;
  return new Date((date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(adjusted * DAY));
}

export function dateToSerial(date: Date, date1904 = false): number {
  const serial = (date.getTime() - (date1904 ? EPOCH_1904 : EPOCH_1900)) / DAY;
  return !date1904 && serial < 60 ? serial - 1 : serial;
}
