import type { Node } from "./parser";
import type { Matrix, Scalar } from "./values";

/** A block of cells on one sheet, not yet read. Bounds are resolved (never -1). */
export interface RangeValue {
  t: "range";
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
export type Value = Scalar | RangeValue | Matrix;

export interface Env {
  /** The sheet and cell the formula lives in. */
  sheet: string;
  row: number;
  col: number;
  cell(sheet: string, row: number, col: number): Scalar;
  /** Rows and columns in use on a sheet, or null when there is no such sheet. */
  extent(sheet: string): { rows: number; cols: number } | null;
  name(name: string): Node | undefined;
  date1904: boolean;
  /** Seconds-resolution "now" as a spreadsheet serial number. */
  now(): number;
}

/** Thrown for a function this engine does not implement, so the cell keeps the value the file stored. */
export class UnsupportedFunction extends Error {
  constructor(readonly fn: string) {
    super(`Unsupported function ${fn}`);
  }
}

export interface FnDef {
  min: number;
  max: number;
  /** Receives syntax nodes and decides what to evaluate (IF, IFERROR, ROW...). */
  lazy?: boolean;
  run(args: Value[], env: Env): Value;
  runLazy?(nodes: (Node | null)[], env: Env, evaluate: (node: Node) => Value): Value;
}
