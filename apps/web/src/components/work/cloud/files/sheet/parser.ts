/** Excel formula text -> syntax tree. No evaluation and no eval(): formulas are data. */
import { colIndex, MAX_ROWS, parseCell } from "./address";
import { isErrorCode, type ErrorCode } from "./values";

export class FormulaSyntaxError extends Error {}

/** A reference to a cell or a block of cells. A bound of -1 means "to the edge of the sheet" (whole columns and rows). */
export interface RefNode {
  t: "ref";
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorCode }
  | RefNode
  | { t: "name"; name: string }
  | { t: "un"; op: "-" | "+"; arg: Node }
  | { t: "pct"; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "call"; name: string; args: (Node | null)[] }
  | { t: "arr"; rows: Node[][] };

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "quoted"; v: string }
  | { k: "err"; v: ErrorCode }
  | { k: "op"; v: string };

const MAX_FORMULA = 8192;
const MAX_DEPTH = 64;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= n) throw new FormulaSyntaxError("Unterminated text");
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i++];
      }
      tokens.push({ k: "str", v: value });
      continue;
    }
    if (ch === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= n) throw new FormulaSyntaxError("Unterminated sheet name");
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i++];
      }
      tokens.push({ k: "quoted", v: value });
      continue;
    }
    if (ch === "#") {
      const match = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/i.exec(source.slice(i));
      if (!match) throw new FormulaSyntaxError("Unknown error value");
      const code = match[0].toUpperCase();
      if (!isErrorCode(code)) throw new FormulaSyntaxError("Unknown error value");
      tokens.push({ k: "err", v: code });
      i += match[0].length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i))!;
      // A run like "1:1" (whole row) or "2024A" is handled by the parser; plain numbers end here.
      tokens.push({ k: "num", v: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.$]/.test(source[j]!)) j++;
      tokens.push({ k: "id", v: source.slice(i, j) });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%(),:;{}!".includes(ch)) {
      tokens.push({ k: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "[") throw new FormulaSyntaxError("Structured table references are not supported");
    throw new FormulaSyntaxError(`Unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private at = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.compare();
    if (this.at < this.tokens.length) throw new FormulaSyntaxError("Unexpected input after the formula");
    return node;
  }
  private peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }
  private isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.k === "op" && token.v === value;
  }
  private take(): Token {
    const token = this.tokens[this.at++];
    if (!token) throw new FormulaSyntaxError("The formula ends too soon");
    return token;
  }
  private expect(value: string) {
    const token = this.take();
    if (token.k !== "op" || token.v !== value) throw new FormulaSyntaxError(`Expected ${value}`);
  }
  private nest<T>(run: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new FormulaSyntaxError("The formula is nested too deeply");
    try {
      return run();
    } finally {
      this.depth--;
    }
  }

  private compare(): Node {
    let left = this.concat();
    for (;;) {
      const token = this.peek();
      if (token?.k === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(token.v)) {
        this.at++;
        left = { t: "bin", op: token.v, l: left, r: this.concat() };
      } else return left;
    }
  }
  private concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.at++;
      left = { t: "bin", op: "&", l: left, r: this.additive() };
    }
    return left;
  }
  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.k === "op" && (token.v === "+" || token.v === "-")) {
        this.at++;
        left = { t: "bin", op: token.v, l: left, r: this.multiplicative() };
      } else return left;
    }
  }
  private multiplicative(): Node {
    let left = this.power();
    for (;;) {
      const token = this.peek();
      if (token?.k === "op" && (token.v === "*" || token.v === "/")) {
        this.at++;
        left = { t: "bin", op: token.v, l: left, r: this.power() };
      } else return left;
    }
  }
  private power(): Node {
    let left = this.percent();
    while (this.isOp("^")) {
      this.at++;
      left = { t: "bin", op: "^", l: left, r: this.percent() };
    }
    return left;
  }
  private percent(): Node {
    let node = this.unary();
    while (this.isOp("%")) {
      this.at++;
      node = { t: "pct", arg: node };
    }
    return node;
  }
  private unary(): Node {
    const token = this.peek();
    if (token?.k === "op" && (token.v === "-" || token.v === "+")) {
      this.at++;
      return { t: "un", op: token.v, arg: this.nest(() => this.unary()) };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.take();
    switch (token.k) {
      case "num": {
        // "1:3" is a whole-row reference.
        if (this.isOp(":") && this.peek(1)?.k === "num" && Number.isInteger(token.v)) {
          const last = this.peek(1) as { k: "num"; v: number };
          if (Number.isInteger(last.v)) {
            this.at += 2;
            return this.rows(null, token.v, last.v);
          }
        }
        return { t: "num", v: token.v };
      }
      case "str":
        return { t: "str", v: token.v };
      case "err":
        return { t: "err", v: token.v };
      case "quoted":
        return this.qualified(token.v);
      case "id":
        return this.identifier(token.v);
      case "op":
        if (token.v === "(") {
          const inner = this.nest(() => this.compare());
          this.expect(")");
          return inner;
        }
        if (token.v === "{") return this.arrayLiteral();
        throw new FormulaSyntaxError(`Unexpected ${token.v}`);
    }
  }

  private arrayLiteral(): Node {
    const rows: Node[][] = [[]];
    for (;;) {
      rows[rows.length - 1]!.push(this.nest(() => this.compare()));
      const token = this.take();
      if (token.k !== "op") throw new FormulaSyntaxError("Bad array constant");
      if (token.v === ",") continue;
      if (token.v === ";") {
        rows.push([]);
        continue;
      }
      if (token.v === "}") break;
      throw new FormulaSyntaxError("Bad array constant");
    }
    const width = rows[0]!.length;
    if (rows.some((row) => row.length !== width)) throw new FormulaSyntaxError("Array rows differ in length");
    return { t: "arr", rows };
  }

  private qualified(sheet: string): Node {
    if (!this.isOp("!")) throw new FormulaSyntaxError("Expected ! after a sheet name");
    this.at++;
    return this.reference(sheet);
  }

  private identifier(text: string): Node {
    const upper = text.toUpperCase();
    if (this.isOp("(")) {
      this.at++;
      return this.call(text);
    }
    if (this.isOp("!")) {
      this.at++;
      return this.reference(text);
    }
    if (upper === "TRUE") return { t: "bool", v: true };
    if (upper === "FALSE") return { t: "bool", v: false };
    return this.referenceFrom(null, text);
  }

  /** After `Sheet!`: a cell, range, whole column or whole row. */
  private reference(sheet: string): Node {
    const token = this.take();
    if (token.k === "id") return this.referenceFrom(sheet, token.v);
    if (token.k === "num" && Number.isInteger(token.v) && this.isOp(":") && this.peek(1)?.k === "num") {
      const last = this.peek(1) as { k: "num"; v: number };
      this.at += 2;
      return this.rows(sheet, token.v, last.v);
    }
    throw new FormulaSyntaxError("Expected a cell after the sheet name");
  }

  private referenceFrom(sheet: string | null, text: string): Node {
    const first = parseCell(text);
    if (first) {
      if (this.isOp(":")) {
        const next = this.peek(1);
        if (next?.k === "id") {
          const second = parseCell(next.v);
          if (second) {
            this.at += 2;
            return {
              t: "ref",
              sheet,
              r1: Math.min(first.row, second.row),
              c1: Math.min(first.col, second.col),
              r2: Math.max(first.row, second.row),
              c2: Math.max(first.col, second.col),
            };
          }
        }
      }
      return { t: "ref", sheet, r1: first.row, c1: first.col, r2: first.row, c2: first.col };
    }
    // Whole columns: A:A, $B:$D
    const column = /^\$?([A-Za-z]{1,3})$/.exec(text);
    if (column && this.isOp(":") && this.peek(1)?.k === "id") {
      const other = /^\$?([A-Za-z]{1,3})$/.exec((this.peek(1) as { k: "id"; v: string }).v);
      const a = colIndex(column[1]!);
      const b = other ? colIndex(other[1]!) : -1;
      if (a >= 0 && b >= 0) {
        this.at += 2;
        return { t: "ref", sheet, r1: 0, c1: Math.min(a, b), r2: -1, c2: Math.max(a, b) };
      }
    }
    if (sheet !== null) throw new FormulaSyntaxError("Expected a cell after the sheet name");
    return { t: "name", name: text };
  }

  private rows(sheet: string | null, from: number, to: number): Node {
    if (from < 1 || to < 1 || from > MAX_ROWS || to > MAX_ROWS) throw new FormulaSyntaxError("Row out of range");
    return { t: "ref", sheet, r1: Math.min(from, to) - 1, c1: 0, r2: Math.max(from, to) - 1, c2: -1 };
  }

  private call(name: string): Node {
    const args: (Node | null)[] = [];
    if (this.isOp(")")) {
      this.at++;
      return { t: "call", name: name.toUpperCase(), args };
    }
    for (;;) {
      // An omitted argument, as in IF(A1,,2).
      if (this.isOp(",") || this.isOp(")")) args.push(null);
      else args.push(this.nest(() => this.compare()));
      const token = this.take();
      if (token.k !== "op") throw new FormulaSyntaxError("Expected , or )");
      if (token.v === ",") continue;
      if (token.v === ")") break;
      throw new FormulaSyntaxError("Expected , or )");
    }
    return { t: "call", name: name.toUpperCase(), args };
  }
}

/** Parses the text after the leading "=". Throws FormulaSyntaxError for anything it cannot read. */
export function parseFormula(source: string): Node {
  const text = source.startsWith("=") ? source.slice(1) : source;
  if (text.length > MAX_FORMULA) throw new FormulaSyntaxError("The formula is too long");
  const tokens = tokenize(text);
  if (!tokens.length) throw new FormulaSyntaxError("The formula is empty");
  return new Parser(tokens).parse();
}
