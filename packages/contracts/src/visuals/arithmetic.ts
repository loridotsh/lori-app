// Adapted from Lori Work’s declarative visual catalog. Keep data-only and bounded.
export const binaryOperators = new Set(["+", "-", "*", "/", "^", "min", "max"]);
export const unaryOperators = new Set(["abs", "round"]);
const literal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const numericToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const functions = new Map<string, (value: number) => number>([
  ["sin", Math.sin], ["cos", Math.cos], ["tan", Math.tan], ["sqrt", Math.sqrt], ["log", Math.log], ["exp", Math.exp],
]);

/** A bounded arithmetic grammar, not a JavaScript interpreter. */
export function compileExpression(source: string | (number | string)[]): (number | string)[] | null {
  if (Array.isArray(source)) return source.length > 0 && source.length <= 64 ? source : null;
  if (source.length > 512) return null;
  const tokens: (number | string)[] = [];
  let remaining = source.trim();
  while (remaining) {
    const token = remaining.match(literal)?.[0] ?? remaining.match(/^[A-Za-z][A-Za-z0-9_]*|^[+\-*/^(),]/)?.[0];
    if (!token || tokens.length >= 128) return null;
    tokens.push(numericToken.test(token) ? Number(token) : token);
    remaining = remaining.slice(token.length).trimStart();
  }
  let cursor = 0;
  const output: (number | string)[] = [];
  const parse = (minimum: number, depth: number): boolean => {
    if (depth > 16 || cursor >= tokens.length) return false;
    const token = tokens[cursor++]!;
    if (typeof token === "number") {
      if (!Number.isFinite(token) || Math.abs(token) > 1e12) return false;
      output.push(token);
    } else if (token === "+" || token === "-") {
      if (token === "-") output.push(0);
      if (!parse(3, depth + 1)) return false;
      if (token === "-") output.push("-");
    } else if (token === "(") {
      if (!parse(0, depth + 1) || tokens[cursor++] !== ")") return false;
    } else if (/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) {
      if (tokens[cursor] === "(") {
        if (!["min", "max", "abs", "round"].includes(token) && !functions.has(token)) return false;
        cursor++;
        if (!parse(0, depth + 1)) return false;
        if ((token === "min" || token === "max") && (tokens[cursor++] !== "," || !parse(0, depth + 1))) return false;
        if (tokens[cursor++] !== ")") return false;
        output.push(functions.has(token) ? `@${token}` : token);
      } else output.push(token);
    } else return false;
    while (cursor < tokens.length) {
      const operator = tokens[cursor]!;
      const precedence = operator === "+" || operator === "-" ? 1 : operator === "*" || operator === "/" ? 2 : operator === "^" ? 4 : -1;
      if (precedence < minimum) break;
      cursor++;
      if (!parse(operator === "^" ? precedence : precedence + 1, depth + 1)) return false;
      output.push(operator);
    }
    return output.length <= 64;
  };
  return parse(0, 0) && cursor === tokens.length ? output : null;
}

export function calculate(expression: string | (number | string)[], values: ReadonlyMap<string, number>): number | null {
  const tokens = compileExpression(expression);
  if (!tokens) return null;
  const stack: number[] = [];
  for (const token of tokens) {
    if (typeof token === "number" || numericToken.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12) return null;
      stack.push(value);
    } else if (binaryOperators.has(token)) {
      if (stack.length < 2) return null;
      const b = stack.pop()!;
      const a = stack.pop()!;
      stack.push(token === "+" ? a + b : token === "-" ? a - b : token === "*" ? a * b
        : token === "/" ? a / b : token === "^" ? a ** b : token === "min" ? Math.min(a, b) : Math.max(a, b));
    } else if (unaryOperators.has(token)) {
      if (!stack.length) return null;
      const a = stack.pop()!;
      stack.push(token === "abs" ? Math.abs(a) : Math.floor(a + 0.5));
    } else if (token.startsWith("@") && functions.has(token.slice(1))) {
      if (!stack.length) return null;
      stack.push(functions.get(token.slice(1))!(stack.pop()!));
    } else if (values.has(token)) stack.push(values.get(token)!);
    else return null;
    const result = stack[stack.length - 1]!;
    if (!Number.isFinite(result) || Math.abs(result) > 1e12) return null;
  }
  return stack.length === 1 ? stack[0]! : null;
}
