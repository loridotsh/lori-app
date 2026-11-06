/** Evaluates a parsed formula against a workbook through an Env. Pure: no globals, no eval(). */
import { isMultiCell, resolveRef, toMatrix, toScalar } from "./array";
import { UnsupportedFunction, type Env, type Value } from "./eval-types";
import { FUNCTIONS } from "./functions";
import type { Node } from "./parser";
import {
  compareScalars,
  ERRORS,
  isError,
  toNumber,
  toText,
  type Matrix,
  type Scalar,
} from "./values";

const MAX_DEPTH = 200;

function arithmetic(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === "&") {
    const x = toText(a);
    const y = toText(b);
    return isError(x) ? x : isError(y) ? y : x + y;
  }
  if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
    const order = compareScalars(a, b);
    switch (op) {
      case "=": return order === 0;
      case "<>": return order !== 0;
      case "<": return order < 0;
      case ">": return order > 0;
      case "<=": return order <= 0;
      default: return order >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? ERRORS["#DIV/0!"] : x / y;
    case "^": {
      if (x === 0 && y === 0) return ERRORS["#NUM!"];
      const result = x ** y;
      return Number.isFinite(result) ? result : ERRORS["#NUM!"];
    }
  }
  return ERRORS["#VALUE!"];
}

/** Elementwise operation with the broadcasting Excel uses: a single row or column stretches to match. */
function broadcast(op: string, left: Matrix, right: Matrix): Matrix {
  const rows = Math.max(left.length, right.length);
  const cols = Math.max(left[0]?.length ?? 0, right[0]?.length ?? 0);
  const pick = (matrix: Matrix, r: number, c: number): Scalar => {
    const row = matrix.length === 1 ? matrix[0]! : matrix[r];
    if (!row) return ERRORS["#N/A"];
    const cell = row.length === 1 ? row[0] : row[c];
    return cell === undefined ? ERRORS["#N/A"] : cell;
  };
  const out: Matrix = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) row.push(arithmetic(op, pick(left, r, c), pick(right, r, c)));
    out.push(row);
  }
  return out;
}

export function evaluate(node: Node, env: Env, depth = 0): Value {
  if (depth > MAX_DEPTH) return ERRORS["#VALUE!"];
  const next = depth + 1;
  switch (node.t) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "err":
      return ERRORS[node.v];
    case "ref": {
      const range = resolveRef(node, env);
      if (!range) return ERRORS["#REF!"];
      if (range.r1 === range.r2 && range.c1 === range.c2 && node.r2 >= 0 && node.c2 >= 0) return env.cell(range.sheet, range.r1, range.c1);
      return range;
    }
    case "name": {
      const target = env.name(node.name);
      return target ? evaluate(target, env, next) : ERRORS["#NAME?"];
    }
    case "un": {
      const value = evaluate(node.arg, env, next);
      if (isMultiCell(value)) {
        return toMatrix(value, env).map((row) => row.map((cell) => unary(node.op, cell)));
      }
      return unary(node.op, toScalar(value, env));
    }
    case "pct": {
      const value = evaluate(node.arg, env, next);
      if (isMultiCell(value)) return toMatrix(value, env).map((row) => row.map(percent));
      return percent(toScalar(value, env));
    }
    case "bin": {
      const left = evaluate(node.l, env, next);
      const right = evaluate(node.r, env, next);
      if (isMultiCell(left) || isMultiCell(right)) return broadcast(node.op, toMatrix(left, env), toMatrix(right, env));
      return arithmetic(node.op, toScalar(left, env), toScalar(right, env));
    }
    case "arr":
      return node.rows.map((row) => row.map((cell) => toScalar(evaluate(cell, env, next), env)));
    case "call": {
      const def = FUNCTIONS[node.name];
      if (!def) throw new UnsupportedFunction(node.name);
      if (node.args.length < def.min || node.args.length > def.max) return ERRORS["#VALUE!"];
      if (def.lazy && def.runLazy) return def.runLazy(node.args, env, (child) => evaluate(child, env, next));
      const args = node.args.map((arg) => (arg === null ? null : evaluate(arg, env, next)));
      return def.run(args, env);
    }
  }
}

function unary(op: "-" | "+", value: Scalar): Scalar {
  if (op === "+") return value;
  const n = toNumber(value);
  return isError(n) ? n : -n;
}
function percent(value: Scalar): Scalar {
  const n = toNumber(value);
  return isError(n) ? n : n / 100;
}

/** The final value shown in a cell: arrays and ranges collapse to their first element. */
export function evaluateCell(node: Node, env: Env): Scalar {
  try {
    return toScalar(evaluate(node, env), env);
  } catch (error) {
    if (error instanceof UnsupportedFunction) throw error;
    if (error instanceof RangeError) return ERRORS["#VALUE!"];
    throw error;
  }
}
