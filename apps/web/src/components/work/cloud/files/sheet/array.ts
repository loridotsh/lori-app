/** Reading ranges and arrays. Shared by the evaluator and the function library. */
import type { Env, RangeValue, Value } from "./eval-types";
import type { RefNode } from "./parser";
import { isError, type Matrix, type Scalar } from "./values";

/** Cells a single range may expand to when it must be read as an array. */
export const MAX_ARRAY_CELLS = 2_000_000;

export const isRange = (value: Value | undefined): value is RangeValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isError(value) && (value as RangeValue).t === "range";

/** Resolves whole-column / whole-row references against the sheet's used extent. */
export function resolveRef(node: RefNode, env: Env): RangeValue | null {
  const sheet = node.sheet ?? env.sheet;
  const extent = env.extent(sheet);
  if (!extent) return null;
  return {
    t: "range",
    sheet,
    r1: node.r1,
    c1: node.c1,
    r2: node.r2 < 0 ? Math.max(extent.rows - 1, node.r1) : node.r2,
    c2: node.c2 < 0 ? Math.max(extent.cols - 1, node.c1) : node.c2,
  };
}

export const rangeSize = (range: RangeValue): number => (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);

/** The cells of a range as a matrix. Cells beyond the sheet's used area are not read (they are blank). */
export function toMatrix(value: Value, env: Env): Matrix {
  if (Array.isArray(value)) return value;
  if (isRange(value)) {
    const extent = env.extent(value.sheet);
    const rows: Matrix = [];
    const lastRow = extent ? Math.min(value.r2, Math.max(extent.rows - 1, value.r1)) : value.r2;
    const lastCol = extent ? Math.min(value.c2, Math.max(extent.cols - 1, value.c1)) : value.c2;
    if ((lastRow - value.r1 + 1) * (lastCol - value.c1 + 1) > MAX_ARRAY_CELLS) throw new RangeError("Range too large");
    for (let r = value.r1; r <= lastRow; r++) {
      const row: Scalar[] = [];
      for (let c = value.c1; c <= lastCol; c++) row.push(env.cell(value.sheet, r, c));
      rows.push(row);
    }
    return rows;
  }
  return [[value]];
}

/** A value in a place that needs one cell's worth: a range or array gives its first cell. */
export function toScalar(value: Value, env: Env): Scalar {
  if (Array.isArray(value)) return value[0]?.[0] ?? null;
  if (isRange(value)) return env.cell(value.sheet, value.r1, value.c1);
  return value;
}

export const isMultiCell = (value: Value): boolean =>
  Array.isArray(value) ? value.length > 1 || (value[0]?.length ?? 0) > 1 : isRange(value) && rangeSize(value) > 1;
