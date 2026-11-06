/** The worksheet functions this engine can calculate. Anything else keeps the value stored in the file. */
import { isRange, toMatrix, toScalar } from "./array";
import type { Env, FnDef, Value } from "./eval-types";
import { formatValue } from "./numfmt";
import {
  compareScalars,
  dateToSerial,
  ERRORS,
  isError,
  parseNumeric,
  serialToDate,
  toBoolean,
  toNumber,
  toText,
  type CellError,
  type Matrix,
  type Scalar,
} from "./values";

export const FUNCTIONS: Record<string, FnDef> = {};
const define = (names: string, min: number, max: number, run: FnDef["run"]) => {
  for (const name of names.split(" ")) FUNCTIONS[name] = { min, max, run };
};
const defineLazy = (names: string, min: number, max: number, runLazy: NonNullable<FnDef["runLazy"]>) => {
  for (const name of names.split(" ")) FUNCTIONS[name] = { min, max, lazy: true, run: () => ERRORS["#VALUE!"], runLazy };
};

const NA = ERRORS["#N/A"];
const VALUE = ERRORS["#VALUE!"];
const NUM = ERRORS["#NUM!"];
const DIV0 = ERRORS["#DIV/0!"];

/* ----------------------------------------------------------------- helpers */

const scalar = (value: Value | undefined, env: Env): Scalar => (value === undefined ? null : toScalar(value, env));
const matrix = (value: Value | undefined, env: Env): Matrix => (value === undefined ? [[null]] : toMatrix(value, env));

function number(value: Value | undefined, env: Env, fallback?: number): number | CellError {
  if (value === undefined || value === null) return fallback ?? 0;
  const result = toNumber(scalar(value, env));
  return result;
}
function integer(value: Value | undefined, env: Env, fallback?: number): number | CellError {
  const n = number(value, env, fallback);
  return isError(n) ? n : Math.trunc(n);
}
function text(value: Value | undefined, env: Env): string | CellError {
  return toText(scalar(value, env));
}

/** Every scalar inside the arguments, flattening ranges and arrays. */
function* cells(args: (Value | undefined)[], env: Env): Generator<{ value: Scalar; direct: boolean }> {
  for (const arg of args) {
    if (arg === undefined) continue;
    if (isRange(arg) || Array.isArray(arg)) {
      for (const row of toMatrix(arg, env)) for (const value of row) yield { value, direct: false };
    } else yield { value: arg, direct: true };
  }
}

/** Numbers for SUM-like functions: ranges contribute only their numbers; typed-in values are coerced. */
function collect(args: (Value | undefined)[], env: Env): number[] | CellError {
  const out: number[] = [];
  for (const { value, direct } of cells(args, env)) {
    if (isError(value)) return value;
    if (typeof value === "number") out.push(value);
    else if (direct) {
      if (value === null) continue;
      const n = toNumber(value);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

const sum = (values: number[]): number => values.reduce((total, n) => total + n, 0);
const finite = (n: number): number | CellError => (Number.isFinite(n) ? n : NUM);

function roundHalfAway(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

/* -------------------------------------------------------------- criteria */

function wildcard(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "~" && i + 1 < pattern.length) source += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** COUNTIF-style criteria: 5, ">=10", "<>done", "a*", "". */
function criterion(raw: Scalar): (cell: Scalar) => boolean {
  if (typeof raw === "number") return (cell) => (typeof cell === "number" ? cell === raw : typeof cell === "string" && parseNumeric(cell) === raw);
  if (typeof raw === "boolean") return (cell) => cell === raw;
  if (raw === null) return (cell) => typeof cell === "number" && cell === 0;
  if (isError(raw)) return (cell) => isError(cell) && cell.code === raw.code;
  const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(raw)!;
  const op = match[1] ?? "=";
  const operand = match[2]!;
  const numeric = parseNumeric(operand);
  if (op === "=" || op === "<>") {
    const equal: (cell: Scalar) => boolean =
      operand === ""
        ? (cell) => cell === null || cell === ""
        : numeric !== null
          ? (cell) => (typeof cell === "number" ? cell === numeric : typeof cell === "string" && parseNumeric(cell) === numeric)
          : /^true$/i.test(operand) || /^false$/i.test(operand)
            ? (cell) => cell === /^true$/i.test(operand)
            : /[*?~]/.test(operand)
              ? ((pattern) => (cell: Scalar) => typeof cell === "string" && pattern.test(cell))(wildcard(operand))
              : (cell) => typeof cell === "string" && cell.toLowerCase() === operand.toLowerCase();
    return op === "=" ? equal : (cell) => !equal(cell);
  }
  const compare = (order: number) => (op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0);
  if (numeric !== null) return (cell) => typeof cell === "number" && compare(cell - numeric);
  return (cell) => typeof cell === "string" && compare(compareScalars(cell, operand));
}

/** The cells matching every (range, criterion) pair, as flat indexes. */
function matching(pairs: Value[], env: Env): { size: number; matches: boolean[] } | CellError {
  const grids: Matrix[] = [];
  const tests: ((cell: Scalar) => boolean)[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    grids.push(matrix(pairs[i], env));
    tests.push(criterion(scalar(pairs[i + 1], env)));
  }
  const rows = grids[0]!.length;
  const cols = grids[0]![0]?.length ?? 0;
  if (grids.some((grid) => grid.length !== rows || (grid[0]?.length ?? 0) !== cols)) return VALUE;
  const matches: boolean[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) matches.push(tests.every((test, index) => test(grids[index]![r]![c]!)));
  return { size: rows * cols, matches };
}

function pickNumbers(range: Matrix, matches: boolean[]): number[] {
  const out: number[] = [];
  let index = 0;
  for (const row of range) for (const value of row) if (matches[index++] && typeof value === "number") out.push(value);
  return out;
}

/** The *IFS family needs the value range to be exactly as large as the criteria ranges. */
function pickStrict(range: Matrix, matched: { size: number; matches: boolean[] }): number[] | CellError {
  const size = range.length * (range[0]?.length ?? 0);
  return size === matched.size ? pickNumbers(range, matched.matches) : VALUE;
}

/* ------------------------------------------------------------------- math */

define("SUM", 1, 255, (args, env) => {
  const values = collect(args, env);
  return isError(values) ? values : sum(values);
});
define("PRODUCT", 1, 255, (args, env) => {
  const values = collect(args, env);
  return isError(values) ? values : values.length ? finite(values.reduce((p, n) => p * n, 1)) : 0;
});
define("SUMSQ", 1, 255, (args, env) => {
  const values = collect(args, env);
  return isError(values) ? values : sum(values.map((n) => n * n));
});
define("AVERAGE", 1, 255, (args, env) => {
  const values = collect(args, env);
  if (isError(values)) return values;
  return values.length ? sum(values) / values.length : DIV0;
});
define("MIN", 1, 255, (args, env) => {
  const values = collect(args, env);
  return isError(values) ? values : values.length ? Math.min(...values) : 0;
});
define("MAX", 1, 255, (args, env) => {
  const values = collect(args, env);
  return isError(values) ? values : values.length ? Math.max(...values) : 0;
});
define("MEDIAN", 1, 255, (args, env) => {
  const values = collect(args, env);
  if (isError(values)) return values;
  if (!values.length) return NUM;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
});
const variance = (values: number[], sample: boolean): number | CellError => {
  const n = values.length;
  if (n < (sample ? 2 : 1)) return DIV0;
  const mean = sum(values) / n;
  return sum(values.map((v) => (v - mean) ** 2)) / (sample ? n - 1 : n);
};
for (const [name, sample, root] of [["STDEV STDEV.S", true, true], ["STDEVP STDEV.P", false, true], ["VAR VAR.S", true, false], ["VARP VAR.P", false, false]] as const)
  define(name, 1, 255, (args, env) => {
    const values = collect(args, env);
    if (isError(values)) return values;
    const result = variance(values, sample);
    return isError(result) ? result : root ? Math.sqrt(result) : result;
  });
define("COUNT", 1, 255, (args, env) => {
  let count = 0;
  for (const { value, direct } of cells(args, env)) {
    if (typeof value === "number") count++;
    else if (direct && (typeof value === "boolean" || (typeof value === "string" && parseNumeric(value) !== null))) count++;
  }
  return count;
});
define("COUNTA", 1, 255, (args, env) => {
  let count = 0;
  for (const { value } of cells(args, env)) if (value !== null) count++;
  return count;
});
define("COUNTBLANK", 1, 1, (args, env) => {
  let count = 0;
  for (const { value } of cells(args, env)) if (value === null || value === "") count++;
  return count;
});
define("ABS", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : Math.abs(n);
});
define("SIGN", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : Math.sign(n);
});
define("SQRT", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : n < 0 ? NUM : Math.sqrt(n);
});
define("EXP", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : finite(Math.exp(n));
});
define("LN", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : n <= 0 ? NUM : Math.log(n);
});
define("LOG10", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : n <= 0 ? NUM : Math.log10(n);
});
define("LOG", 1, 2, (args, env) => {
  const n = number(args[0], env);
  const base = number(args[1], env, 10);
  if (isError(n)) return n;
  if (isError(base)) return base;
  return n <= 0 || base <= 0 || base === 1 ? NUM : Math.log(n) / Math.log(base);
});
define("PI", 0, 0, () => Math.PI);
define("POWER", 2, 2, (args, env) => {
  const a = number(args[0], env);
  const b = number(args[1], env);
  if (isError(a)) return a;
  if (isError(b)) return b;
  return a === 0 && b === 0 ? NUM : finite(a ** b);
});
define("MOD", 2, 2, (args, env) => {
  const a = number(args[0], env);
  const b = number(args[1], env);
  if (isError(a)) return a;
  if (isError(b)) return b;
  return b === 0 ? DIV0 : a - b * Math.floor(a / b);
});
define("INT", 1, 1, (args, env) => {
  const n = number(args[0], env);
  return isError(n) ? n : Math.floor(n);
});
define("TRUNC", 1, 2, (args, env) => {
  const n = number(args[0], env);
  const digits = integer(args[1], env, 0);
  if (isError(n)) return n;
  if (isError(digits)) return digits;
  const factor = 10 ** digits;
  return Math.trunc(Number((n * factor).toPrecision(15))) / factor;
});
for (const [name, mode] of [["ROUND", "half"], ["ROUNDUP", "up"], ["ROUNDDOWN", "down"]] as const)
  define(name, 2, 2, (args, env) => {
    const n = number(args[0], env);
    const digits = integer(args[1], env);
    if (isError(n)) return n;
    if (isError(digits)) return digits;
    if (mode === "half") return roundHalfAway(n, digits);
    const factor = 10 ** digits;
    const scaled = Number((Math.abs(n) * factor).toPrecision(15));
    return (Math.sign(n) * (mode === "up" ? Math.ceil(scaled) : Math.floor(scaled))) / factor;
  });
define("CEILING", 1, 2, (args, env) => {
  const n = number(args[0], env);
  const significance = number(args[1], env, 1);
  if (isError(n)) return n;
  if (isError(significance)) return significance;
  return significance === 0 ? 0 : Math.ceil(n / significance) * significance;
});
define("FLOOR", 1, 2, (args, env) => {
  const n = number(args[0], env);
  const significance = number(args[1], env, 1);
  if (isError(n)) return n;
  if (isError(significance)) return significance;
  return significance === 0 ? DIV0 : Math.floor(n / significance) * significance;
});
define("SUMPRODUCT", 1, 30, (args, env) => {
  const grids = args.map((arg) => matrix(arg, env));
  const rows = grids[0]!.length;
  const cols = grids[0]![0]?.length ?? 0;
  if (grids.some((grid) => grid.length !== rows || (grid[0]?.length ?? 0) !== cols)) return VALUE;
  let total = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let product = 1;
      for (const grid of grids) {
        const cell = grid[r]![c]!;
        if (isError(cell)) return cell;
        product *= typeof cell === "number" ? cell : typeof cell === "boolean" ? Number(cell) : 0;
      }
      total += product;
    }
  return total;
});
for (const [name, large] of [["LARGE", true], ["SMALL", false]] as const)
  define(name, 2, 2, (args, env) => {
    const values = collect([args[0]], env);
    const k = integer(args[1], env);
    if (isError(values)) return values;
    if (isError(k)) return k;
    if (k < 1 || k > values.length) return NUM;
    const sorted = [...values].sort((a, b) => (large ? b - a : a - b));
    return sorted[k - 1]!;
  });
define("RANK RANK.EQ", 2, 3, (args, env) => {
  const n = number(args[0], env);
  const values = collect([args[1]], env);
  const order = number(args[2], env, 0);
  if (isError(n)) return n;
  if (isError(values)) return values;
  if (isError(order)) return order;
  if (!values.includes(n)) return NA;
  return 1 + values.filter((v) => (order ? v < n : v > n)).length;
});
define("RAND", 0, 0, () => Math.random());
define("RANDBETWEEN", 2, 2, (args, env) => {
  const low = integer(args[0], env);
  const high = integer(args[1], env);
  if (isError(low)) return low;
  if (isError(high)) return high;
  return high < low ? NUM : low + Math.floor(Math.random() * (high - low + 1));
});

/* ------------------------------------------- conditional sums and counts */

define("COUNTIF", 2, 2, (args, env) => {
  const result = matching(args as Value[], env);
  return isError(result) ? result : result.matches.filter(Boolean).length;
});
define("COUNTIFS", 2, 254, (args, env) => {
  if (args.length % 2) return VALUE;
  const result = matching(args as Value[], env);
  return isError(result) ? result : result.matches.filter(Boolean).length;
});
define("SUMIF", 2, 3, (args, env) => {
  const result = matching([args[0]!, args[1]!], env);
  if (isError(result)) return result;
  const target = matrix(args[2] ?? args[0], env);
  return sum(pickNumbers(target, result.matches));
});
define("SUMIFS", 3, 255, (args, env) => {
  if (args.length % 2 === 0) return VALUE;
  const result = matching(args.slice(1) as Value[], env);
  if (isError(result)) return result;
  const values = pickStrict(matrix(args[0], env), result);
  return isError(values) ? values : sum(values);
});
define("AVERAGEIF", 2, 3, (args, env) => {
  const result = matching([args[0]!, args[1]!], env);
  if (isError(result)) return result;
  const values = pickNumbers(matrix(args[2] ?? args[0], env), result.matches);
  return values.length ? sum(values) / values.length : DIV0;
});
define("AVERAGEIFS", 3, 255, (args, env) => {
  if (args.length % 2 === 0) return VALUE;
  const result = matching(args.slice(1) as Value[], env);
  if (isError(result)) return result;
  const values = pickStrict(matrix(args[0], env), result);
  if (isError(values)) return values;
  return values.length ? sum(values) / values.length : DIV0;
});
for (const [name, pick] of [["MAXIFS", Math.max], ["MINIFS", Math.min]] as const)
  define(name, 3, 255, (args, env) => {
    if (args.length % 2 === 0) return VALUE;
    const result = matching(args.slice(1) as Value[], env);
    if (isError(result)) return result;
    const values = pickStrict(matrix(args[0], env), result);
    if (isError(values)) return values;
    return values.length ? pick(...values) : 0;
  });
define("SUBTOTAL", 2, 255, (args, env) => {
  const code = integer(args[0], env);
  if (isError(code)) return code;
  const function_ = ({ 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV", 8: "STDEVP", 9: "SUM", 10: "VAR", 11: "VARP" } as Record<number, string>)[code > 100 ? code - 100 : code];
  return function_ ? FUNCTIONS[function_]!.run(args.slice(1), env) : VALUE;
});

/* ---------------------------------------------------------------- logical */

defineLazy("IF", 2, 3, (nodes, env, evaluate) => {
  const test = nodes[0] ? toBoolean(toScalar(evaluate(nodes[0]), env)) : false;
  if (isError(test)) return test;
  const branch = test ? nodes[1] : nodes[2];
  if (branch === undefined) return false;
  return branch === null ? 0 : evaluate(branch);
});
defineLazy("IFS", 2, 254, (nodes, env, evaluate) => {
  for (let i = 0; i + 1 < nodes.length; i += 2) {
    const test = nodes[i] ? toBoolean(toScalar(evaluate(nodes[i]!), env)) : false;
    if (isError(test)) return test;
    if (test) return nodes[i + 1] ? evaluate(nodes[i + 1]!) : 0;
  }
  return NA;
});
defineLazy("IFERROR", 2, 2, (nodes, env, evaluate) => {
  const value = nodes[0] ? evaluate(nodes[0]) : null;
  return isError(toScalar(value, env)) ? (nodes[1] ? evaluate(nodes[1]) : 0) : value;
});
defineLazy("IFNA", 2, 2, (nodes, env, evaluate) => {
  const value = nodes[0] ? evaluate(nodes[0]) : null;
  const first = toScalar(value, env);
  return isError(first) && first.code === "#N/A" ? (nodes[1] ? evaluate(nodes[1]) : 0) : value;
});
defineLazy("SWITCH", 3, 255, (nodes, env, evaluate) => {
  const subject = nodes[0] ? toScalar(evaluate(nodes[0]), env) : null;
  if (isError(subject)) return subject;
  let i = 1;
  for (; i + 1 < nodes.length; i += 2) {
    const candidate = nodes[i] ? toScalar(evaluate(nodes[i]!), env) : null;
    if (isError(candidate)) return candidate;
    if (compareScalars(subject, candidate) === 0) return nodes[i + 1] ? evaluate(nodes[i + 1]!) : 0;
  }
  return i < nodes.length ? (nodes[i] ? evaluate(nodes[i]!) : 0) : NA;
});
defineLazy("CHOOSE", 2, 255, (nodes, env, evaluate) => {
  const index = nodes[0] ? toNumber(toScalar(evaluate(nodes[0]), env)) : 0;
  if (isError(index)) return index;
  const chosen = nodes[Math.trunc(index)];
  return Math.trunc(index) < 1 || chosen === undefined ? VALUE : chosen === null ? 0 : evaluate(chosen);
});
const truth = (args: (Value | undefined)[], env: Env): boolean[] | CellError => {
  const out: boolean[] = [];
  for (const { value, direct } of cells(args, env)) {
    if (isError(value)) return value;
    if (value === null || (!direct && typeof value === "string")) continue;
    const b = toBoolean(value);
    if (isError(b)) return b;
    out.push(b);
  }
  return out;
};
define("AND", 1, 255, (args, env) => {
  const values = truth(args, env);
  return isError(values) ? values : values.length ? values.every(Boolean) : VALUE;
});
define("OR", 1, 255, (args, env) => {
  const values = truth(args, env);
  return isError(values) ? values : values.length ? values.some(Boolean) : VALUE;
});
define("XOR", 1, 255, (args, env) => {
  const values = truth(args, env);
  return isError(values) ? values : values.filter(Boolean).length % 2 === 1;
});
define("NOT", 1, 1, (args, env) => {
  const b = toBoolean(scalar(args[0], env));
  return isError(b) ? b : !b;
});
define("TRUE", 0, 0, () => true);
define("FALSE", 0, 0, () => false);
define("NA", 0, 0, () => NA);
define("ISBLANK", 1, 1, (args, env) => scalar(args[0], env) === null);
define("ISNUMBER", 1, 1, (args, env) => typeof scalar(args[0], env) === "number");
define("ISTEXT", 1, 1, (args, env) => typeof scalar(args[0], env) === "string");
define("ISNONTEXT", 1, 1, (args, env) => typeof scalar(args[0], env) !== "string");
define("ISLOGICAL", 1, 1, (args, env) => typeof scalar(args[0], env) === "boolean");
define("ISERROR", 1, 1, (args, env) => isError(scalar(args[0], env)));
define("ISERR", 1, 1, (args, env) => {
  const value = scalar(args[0], env);
  return isError(value) && value.code !== "#N/A";
});
define("ISNA", 1, 1, (args, env) => {
  const value = scalar(args[0], env);
  return isError(value) && value.code === "#N/A";
});
for (const [name, even] of [["ISEVEN", true], ["ISODD", false]] as const)
  define(name, 1, 1, (args, env) => {
    const n = number(args[0], env);
    return isError(n) ? n : (Math.floor(Math.abs(n)) % 2 === 0) === even;
  });
define("N", 1, 1, (args, env) => {
  const value = scalar(args[0], env);
  return isError(value) ? value : typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : 0;
});

/* ------------------------------------------------------------------ text */

define("LEN", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : [...value].length;
});
define("UPPER", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value.toUpperCase();
});
define("LOWER", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value.toLowerCase();
});
define("PROPER", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
});
define("TRIM", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value.replace(/ +/g, " ").trim();
});
define("CLEAN", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value.replace(/[\u0000-\u001f]/g, "");
});
for (const [name, left] of [["LEFT", true], ["RIGHT", false]] as const)
  define(name, 1, 2, (args, env) => {
    const value = text(args[0], env);
    const count = integer(args[1], env, 1);
    if (isError(value)) return value;
    if (isError(count)) return count;
    if (count < 0) return VALUE;
    const chars = [...value];
    return (left ? chars.slice(0, count) : chars.slice(Math.max(0, chars.length - count))).join("");
  });
define("MID", 3, 3, (args, env) => {
  const value = text(args[0], env);
  const start = integer(args[1], env);
  const count = integer(args[2], env);
  if (isError(value)) return value;
  if (isError(start)) return start;
  if (isError(count)) return count;
  if (start < 1 || count < 0) return VALUE;
  return [...value].slice(start - 1, start - 1 + count).join("");
});
define("REPT", 2, 2, (args, env) => {
  const value = text(args[0], env);
  const count = integer(args[1], env);
  if (isError(value)) return value;
  if (isError(count)) return count;
  return count < 0 || value.length * count > 32767 ? VALUE : value.repeat(count);
});
define("EXACT", 2, 2, (args, env) => {
  const a = text(args[0], env);
  const b = text(args[1], env);
  return isError(a) ? a : isError(b) ? b : a === b;
});
define("CONCATENATE CONCAT", 1, 255, (args, env) => {
  let out = "";
  for (const { value } of cells(args, env)) {
    const piece = toText(value);
    if (isError(piece)) return piece;
    out += piece;
  }
  return out;
});
define("TEXTJOIN", 3, 255, (args, env) => {
  const delimiter = text(args[0], env);
  const skipEmpty = toBoolean(scalar(args[1], env));
  if (isError(delimiter)) return delimiter;
  if (isError(skipEmpty)) return skipEmpty;
  const parts: string[] = [];
  for (const { value } of cells(args.slice(2), env)) {
    const piece = toText(value);
    if (isError(piece)) return piece;
    if (!(skipEmpty && piece === "")) parts.push(piece);
  }
  return parts.join(delimiter);
});
define("SUBSTITUTE", 3, 4, (args, env) => {
  const source = text(args[0], env);
  const find = text(args[1], env);
  const replacement = text(args[2], env);
  const instance = args[3] === undefined ? null : integer(args[3], env);
  if (isError(source)) return source;
  if (isError(find)) return find;
  if (isError(replacement)) return replacement;
  if (instance !== null && isError(instance)) return instance;
  if (!find) return source;
  if (instance === null) return source.split(find).join(replacement);
  if (instance < 1) return VALUE;
  let seen = 0;
  let at = -1;
  for (;;) {
    at = source.indexOf(find, at + 1);
    if (at < 0) return source;
    if (++seen === instance) return source.slice(0, at) + replacement + source.slice(at + find.length);
  }
});
define("REPLACE", 4, 4, (args, env) => {
  const source = text(args[0], env);
  const start = integer(args[1], env);
  const count = integer(args[2], env);
  const insert = text(args[3], env);
  if (isError(source)) return source;
  if (isError(start)) return start;
  if (isError(count)) return count;
  if (isError(insert)) return insert;
  if (start < 1 || count < 0) return VALUE;
  const chars = [...source];
  return chars.slice(0, start - 1).join("") + insert + chars.slice(start - 1 + count).join("");
});
for (const [name, sensitive] of [["FIND", true], ["SEARCH", false]] as const)
  define(name, 2, 3, (args, env) => {
    const needle = text(args[0], env);
    const haystack = text(args[1], env);
    const start = integer(args[2], env, 1);
    if (isError(needle)) return needle;
    if (isError(haystack)) return haystack;
    if (isError(start)) return start;
    if (start < 1 || start > haystack.length + 1) return VALUE;
    let at: number;
    if (sensitive) at = haystack.indexOf(needle, start - 1);
    else {
      const pattern = wildcard(needle);
      at = -1;
      for (let i = start - 1; i <= haystack.length && at < 0; i++)
        for (let j = haystack.length; j >= i; j--) if (pattern.test(haystack.slice(i, j))) { at = i; break; }
      if (!/[*?~]/.test(needle)) at = haystack.toLowerCase().indexOf(needle.toLowerCase(), start - 1);
    }
    return at < 0 ? VALUE : at + 1;
  });
define("VALUE", 1, 1, (args, env) => {
  const value = scalar(args[0], env);
  if (isError(value)) return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseNumeric(value);
    return parsed === null ? VALUE : parsed;
  }
  return value === null ? 0 : toNumber(value);
});
define("TEXT", 2, 2, (args, env) => {
  const value = scalar(args[0], env);
  const code = text(args[1], env);
  if (isError(value)) return value;
  if (isError(code)) return code;
  return formatValue(typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value, code, env.date1904).text;
});
define("CHAR", 1, 1, (args, env) => {
  const n = integer(args[0], env);
  return isError(n) ? n : n < 1 || n > 255 ? VALUE : String.fromCharCode(n);
});
define("CODE", 1, 1, (args, env) => {
  const value = text(args[0], env);
  return isError(value) ? value : value ? value.charCodeAt(0) : VALUE;
});
define("T", 1, 1, (args, env) => {
  const value = scalar(args[0], env);
  return typeof value === "string" || isError(value) ? value : "";
});

/* ----------------------------------------------------------------- lookup */

const lookupEqual = (a: Scalar, b: Scalar): boolean => !isError(a) && !isError(b) && a !== null && compareScalars(a, b) === 0 && typeof a === typeof b;

/** Index of the match in a flat list: exact, or the largest value <= target in a sorted list. */
function findIndex(list: Scalar[], target: Scalar, mode: 0 | 1 | -1): number {
  if (mode === 0) {
    if (typeof target === "string" && /[*?~]/.test(target)) {
      const pattern = wildcard(target);
      return list.findIndex((item) => typeof item === "string" && pattern.test(item));
    }
    return list.findIndex((item) => lookupEqual(item, target));
  }
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const item = list[i]!;
    if (item === null || isError(item) || typeof item !== typeof target) continue;
    const order = compareScalars(item, target);
    if (mode === 1 ? order <= 0 : order >= 0) {
      if (best < 0 || (mode === 1 ? compareScalars(item, list[best]!) >= 0 : compareScalars(item, list[best]!) <= 0)) best = i;
      if (order === 0) return i;
    }
  }
  return best;
}

for (const [name, vertical] of [["VLOOKUP", true], ["HLOOKUP", false]] as const)
  define(name, 3, 4, (args, env) => {
    const target = scalar(args[0], env);
    const table = matrix(args[1], env);
    const index = integer(args[2], env);
    const approximate = args[3] === undefined ? true : toBoolean(scalar(args[3], env));
    if (isError(target)) return target;
    if (isError(index)) return index;
    if (isError(approximate)) return approximate;
    const lead = vertical ? table.map((row) => row[0] ?? null) : (table[0] ?? []);
    const size = vertical ? (table[0]?.length ?? 0) : table.length;
    if (index < 1 || index > size) return ERRORS["#REF!"];
    const at = findIndex(lead, target, approximate ? 1 : 0);
    if (at < 0) return NA;
    return vertical ? (table[at]![index - 1] ?? null) : (table[index - 1]![at] ?? null);
  });
define("MATCH", 2, 3, (args, env) => {
  const target = scalar(args[0], env);
  const grid = matrix(args[1], env);
  const type = integer(args[2], env, 1);
  if (isError(target)) return target;
  if (isError(type)) return type;
  const list = grid.length === 1 ? grid[0]! : grid.map((row) => row[0] ?? null);
  const at = findIndex(list, target, type === 0 ? 0 : type > 0 ? 1 : -1);
  return at < 0 ? NA : at + 1;
});
define("INDEX", 2, 3, (args, env) => {
  const grid = matrix(args[0], env);
  const row = integer(args[1], env, 0);
  const col = integer(args[2], env, 0);
  if (isError(row)) return row;
  if (isError(col)) return col;
  const oneRow = grid.length === 1;
  const r = oneRow && args[2] === undefined ? 1 : row;
  const c = oneRow && args[2] === undefined ? row : col;
  if (r < 0 || c < 0) return VALUE;
  if (r > grid.length || c > (grid[0]?.length ?? 0)) return ERRORS["#REF!"];
  if (r === 0 && c === 0) return grid;
  if (r === 0) return grid.map((line) => [line[c - 1] ?? null]);
  if (c === 0) return [grid[r - 1]!];
  return grid[r - 1]![c - 1] ?? null;
});
define("XLOOKUP", 3, 6, (args, env) => {
  const target = scalar(args[0], env);
  const lookup = matrix(args[1], env);
  const result = matrix(args[2], env);
  const mode = integer(args[4], env, 0);
  if (isError(target)) return target;
  if (isError(mode)) return mode;
  // A row of lookup values returns a column of the result; a column returns a row.
  const horizontal = lookup.length === 1 && (lookup[0]?.length ?? 0) > 1;
  const list = horizontal ? lookup[0]! : lookup.map((row) => row[0] ?? null);
  const at = findIndex(list, target, mode === 0 || mode === 2 ? 0 : mode > 0 ? -1 : 1);
  if (at < 0) return args[3] === undefined ? NA : (args[3] ?? null);
  if (horizontal) {
    const column = result.map((row) => row[at] ?? null);
    return column.length === 1 ? column[0]! : column.map((cell) => [cell]);
  }
  const row = result[at] ?? [];
  return row.length === 1 ? row[0]! : [row];
});
for (const [name, byRow] of [["ROW", true], ["COLUMN", false]] as const)
  defineLazy(name, 0, 1, (nodes, env) => {
    const node = nodes[0];
    if (!node) return byRow ? env.row + 1 : env.col + 1;
    if (node.t !== "ref") return VALUE;
    return byRow ? node.r1 + 1 : node.c1 + 1;
  });
for (const [name, byRow] of [["ROWS", true], ["COLUMNS", false]] as const)
  define(name, 1, 1, (args, env) => {
    const value = args[0]!;
    if (isRange(value)) return byRow ? value.r2 - value.r1 + 1 : value.c2 - value.c1 + 1;
    const grid = toMatrix(value, env);
    return byRow ? grid.length : (grid[0]?.length ?? 0);
  });

/* ------------------------------------------------------------------ dates */

const serial = (year: number, month: number, day: number, env: Env): number => dateToSerial(new Date(Date.UTC(year, month - 1, day)), env.date1904);
const asDate = (value: Value | undefined, env: Env): Date | CellError => {
  const n = number(value, env);
  return isError(n) ? n : n < 0 ? NUM : serialToDate(Math.floor(n), env.date1904);
};

define("TODAY", 0, 0, (_args, env) => Math.floor(env.now()));
define("NOW", 0, 0, (_args, env) => env.now());
define("DATE", 3, 3, (args, env) => {
  const year = integer(args[0], env);
  const month = integer(args[1], env);
  const day = integer(args[2], env);
  if (isError(year)) return year;
  if (isError(month)) return month;
  if (isError(day)) return day;
  const fullYear = year >= 0 && year < 1900 ? year + 1900 : year;
  return fullYear < 0 || fullYear > 9999 ? NUM : serial(fullYear, month, day, env);
});
define("TIME", 3, 3, (args, env) => {
  const h = integer(args[0], env);
  const m = integer(args[1], env);
  const s = integer(args[2], env);
  if (isError(h)) return h;
  if (isError(m)) return m;
  if (isError(s)) return s;
  const total = (h * 3600 + m * 60 + s) / 86400;
  return total < 0 ? NUM : total % 1;
});
for (const [name, part] of [["YEAR", "y"], ["MONTH", "m"], ["DAY", "d"]] as const)
  define(name, 1, 1, (args, env) => {
    const date = asDate(args[0], env);
    if (isError(date)) return date;
    return part === "y" ? date.getUTCFullYear() : part === "m" ? date.getUTCMonth() + 1 : date.getUTCDate();
  });
for (const [name, divisor, modulo] of [["HOUR", 3600, 24], ["MINUTE", 60, 60], ["SECOND", 1, 60]] as const)
  define(name, 1, 1, (args, env) => {
    const n = number(args[0], env);
    if (isError(n)) return n;
    const seconds = Math.round((n - Math.floor(n)) * 86400);
    return Math.floor(seconds / divisor) % modulo;
  });
define("WEEKDAY", 1, 2, (args, env) => {
  const date = asDate(args[0], env);
  const type = integer(args[1], env, 1);
  if (isError(date)) return date;
  if (isError(type)) return type;
  const day = date.getUTCDay();
  return type === 2 ? ((day + 6) % 7) + 1 : type === 3 ? (day + 6) % 7 : day + 1;
});
for (const [name, end] of [["EDATE", false], ["EOMONTH", true]] as const)
  define(name, 2, 2, (args, env) => {
    const date = asDate(args[0], env);
    const months = integer(args[1], env);
    if (isError(date)) return date;
    if (isError(months)) return months;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    if (end) return serial(year, month + 2, 0, env);
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return serial(year, month + 1, Math.min(date.getUTCDate(), lastDay), env);
  });
define("DAYS", 2, 2, (args, env) => {
  const end = number(args[0], env);
  const start = number(args[1], env);
  if (isError(end)) return end;
  if (isError(start)) return start;
  return Math.floor(end) - Math.floor(start);
});
define("DATEDIF", 3, 3, (args, env) => {
  const start = asDate(args[0], env);
  const end = asDate(args[1], env);
  const unit = text(args[2], env);
  if (isError(start)) return start;
  if (isError(end)) return end;
  if (isError(unit)) return unit;
  if (end < start) return NUM;
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() - (end.getUTCDate() < start.getUTCDate() ? 1 : 0);
  switch (unit.toUpperCase()) {
    case "D": return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
    case "M": return months;
    case "Y": return Math.floor(months / 12);
    default: return NUM;
  }
});

/* -------------------------------------------------------------- financial */

define("PMT", 3, 5, (args, env) => {
  const rate = number(args[0], env);
  const periods = number(args[1], env);
  const present = number(args[2], env);
  const future = number(args[3], env, 0);
  const type = number(args[4], env, 0);
  for (const item of [rate, periods, present, future, type]) if (isError(item)) return item;
  const [r, n, pv, fv, t] = [rate, periods, present, future, type] as number[];
  if (n === 0) return NUM;
  if (r === 0) return -(pv! + fv!) / n!;
  const growth = (1 + r!) ** n!;
  return (-(pv! * growth + fv!) * r!) / ((1 + r! * t!) * (growth - 1));
});
define("FV", 3, 5, (args, env) => {
  const rate = number(args[0], env);
  const periods = number(args[1], env);
  const payment = number(args[2], env);
  const present = number(args[3], env, 0);
  const type = number(args[4], env, 0);
  for (const item of [rate, periods, payment, present, type]) if (isError(item)) return item;
  const [r, n, pmt, pv, t] = [rate, periods, payment, present, type] as number[];
  if (r === 0) return -(pv! + pmt! * n!);
  const growth = (1 + r!) ** n!;
  return -(pv! * growth + (pmt! * (1 + r! * t!) * (growth - 1)) / r!);
});
define("PV", 3, 5, (args, env) => {
  const rate = number(args[0], env);
  const periods = number(args[1], env);
  const payment = number(args[2], env);
  const future = number(args[3], env, 0);
  const type = number(args[4], env, 0);
  for (const item of [rate, periods, payment, future, type]) if (isError(item)) return item;
  const [r, n, pmt, fv, t] = [rate, periods, payment, future, type] as number[];
  if (r === 0) return -(fv! + pmt! * n!);
  const growth = (1 + r!) ** n!;
  return -(fv! + (pmt! * (1 + r! * t!) * (growth - 1)) / r!) / growth;
});
define("NPV", 2, 255, (args, env) => {
  const rate = number(args[0], env);
  const flows = collect(args.slice(1), env);
  if (isError(rate)) return rate;
  if (isError(flows)) return flows;
  return flows.reduce((total, flow, index) => total + flow / (1 + rate) ** (index + 1), 0);
});
define("IRR", 1, 2, (args, env) => {
  const flows = collect([args[0]], env);
  const guess = number(args[1], env, 0.1);
  if (isError(flows)) return flows;
  if (isError(guess)) return guess;
  if (!flows.some((f) => f > 0) || !flows.some((f) => f < 0)) return NUM;
  let rate = guess;
  for (let step = 0; step < 100; step++) {
    let value = 0;
    let slope = 0;
    flows.forEach((flow, index) => {
      value += flow / (1 + rate) ** index;
      slope -= (index * flow) / (1 + rate) ** (index + 1);
    });
    if (Math.abs(value) < 1e-9) return rate;
    if (slope === 0) return NUM;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -1) return NUM;
    rate = next;
  }
  return NUM;
});
define("NPER", 3, 5, (args, env) => {
  const rate = number(args[0], env);
  const payment = number(args[1], env);
  const present = number(args[2], env);
  const future = number(args[3], env, 0);
  const type = number(args[4], env, 0);
  for (const item of [rate, payment, present, future, type]) if (isError(item)) return item;
  const [r, pmt, pv, fv, t] = [rate, payment, present, future, type] as number[];
  if (r === 0) return pmt === 0 ? NUM : -(pv! + fv!) / pmt!;
  const adjusted = pmt! * (1 + r! * t!);
  const top = adjusted - fv! * r!;
  const bottom = adjusted + pv! * r!;
  return top <= 0 || bottom <= 0 ? NUM : Math.log(top / bottom) / Math.log(1 + r!);
});
