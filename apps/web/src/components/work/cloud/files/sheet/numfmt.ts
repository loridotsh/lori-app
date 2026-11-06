/** Excel number formats: "#,##0.00", "0.0%", "yyyy-mm-dd", "[Red]($#,##0)", and the built-in numbered ones. */
import { isError, numberToText, serialToDate, type Scalar } from "./values";

export interface Formatted {
  text: string;
  /** A color named in the format, such as [Red]. */
  color?: string;
  /** True when the value was text, a boolean or an error, which a grid aligns left by default. */
  isText: boolean;
}

export const BUILT_IN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0_);(#,##0)",
  38: "#,##0_);[Red](#,##0)",
  39: "#,##0.00_);(#,##0.00)",
  40: "#,##0.00_);[Red](#,##0.00)",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

const COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#008000",
  magenta: "#ff00ff",
  red: "#c00000",
  white: "#ffffff",
  yellow: "#ffff00",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Piece =
  | { k: "lit"; v: string }
  | { k: "digit"; v: "0" | "#" | "?" }
  | { k: "point" }
  | { k: "comma" }
  | { k: "percent" }
  | { k: "exp"; sign: "+" | "-" }
  | { k: "text" }
  | { k: "date"; v: string }
  | { k: "elapsed"; v: "h" | "m" | "s"; n: number }
  | { k: "ampm"; v: string };

interface Section {
  pieces: Piece[];
  color?: string;
  condition?: (value: number) => boolean;
  isDate: boolean;
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\\" && !quoted) {
      current += ch + (code[++i] ?? "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) {
      sections.push(current);
      current = "";
    } else current += ch;
  }
  sections.push(current);
  return sections;
}

function parseSection(text: string): Section {
  const pieces: Piece[] = [];
  let color: string | undefined;
  let condition: Section["condition"];
  let isDate = false;
  let i = 0;
  const run = (pattern: RegExp, rest: string) => pattern.exec(rest)![0];
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? text.length : end;
      pieces.push({ k: "lit", v: text.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    if (ch === "\\") {
      pieces.push({ k: "lit", v: text[i + 1] ?? "" });
      i += 2;
      continue;
    }
    if (ch === "_") {
      pieces.push({ k: "lit", v: " " });
      i += 2;
      continue;
    }
    if (ch === "*") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const end = text.indexOf("]", i);
      if (end < 0) break;
      const body = text.slice(i + 1, end);
      const lower = body.toLowerCase();
      if (COLORS[lower]) color = COLORS[lower];
      else if (/^h+$|^m+$|^s+$/.test(lower)) {
        pieces.push({ k: "elapsed", v: lower[0] as "h" | "m" | "s", n: lower.length });
        isDate = true;
      } else if (/^[<>=]/.test(body)) {
        const match = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(body);
        if (match) {
          const limit = Number(match[2]);
          const op = match[1]!;
          condition = (value) =>
            op === "<" ? value < limit : op === ">" ? value > limit : op === "<=" ? value <= limit : op === ">=" ? value >= limit : op === "=" ? value === limit : value !== limit;
        }
      } else if (body.startsWith("$")) {
        const symbol = body.slice(1).split("-")[0] ?? "";
        if (symbol) pieces.push({ k: "lit", v: symbol });
      }
      i = end + 1;
      continue;
    }
    const rest = text.slice(i);
    const ampm = /^(AM\/PM|A\/P)/i.exec(rest);
    if (ampm) {
      pieces.push({ k: "ampm", v: ampm[0] });
      isDate = true;
      i += ampm[0].length;
      continue;
    }
    if (/[yY]/.test(ch)) {
      const length = run(/^y+/i, rest).length;
      pieces.push({ k: "date", v: length <= 2 ? "yy" : "yyyy" });
      isDate = true;
      i += length;
      continue;
    }
    if (/[mM]/.test(ch)) {
      const token = run(/^m+/i, rest);
      pieces.push({ k: "date", v: token.toLowerCase() });
      isDate = true;
      i += token.length;
      continue;
    }
    if (/[dD]/.test(ch)) {
      const token = run(/^d+/i, rest);
      pieces.push({ k: "date", v: token.toLowerCase().slice(0, 4) });
      isDate = true;
      i += token.length;
      continue;
    }
    if (/[hH]/.test(ch)) {
      const token = run(/^h+/i, rest);
      pieces.push({ k: "date", v: token.toLowerCase().slice(0, 2) });
      isDate = true;
      i += token.length;
      continue;
    }
    if (/[sS]/.test(ch)) {
      const token = run(/^s+/i, rest);
      pieces.push({ k: "date", v: token.toLowerCase().slice(0, 2) });
      isDate = true;
      i += token.length;
      continue;
    }
    if (/^E[+-]/i.test(rest)) {
      pieces.push({ k: "exp", sign: rest[1] === "-" ? "-" : "+" });
      i += 2;
      continue;
    }
    if (ch === "0" || ch === "#" || ch === "?") pieces.push({ k: "digit", v: ch });
    else if (ch === ".") pieces.push({ k: "point" });
    else if (ch === ",") pieces.push({ k: "comma" });
    else if (ch === "%") pieces.push({ k: "percent" });
    else if (ch === "@") pieces.push({ k: "text" });
    else pieces.push({ k: "lit", v: ch });
    i++;
  }
  // In a date, a comma is just a comma ("mmm d, yyyy").
  if (isDate) for (let index = 0; index < pieces.length; index++) if (pieces[index]!.k === "comma") pieces[index] = { k: "lit", v: "," };
  return { pieces, color, condition, isDate };
}

const sectionCache = new Map<string, Section[]>();
function parseFormat(code: string): Section[] {
  const cached = sectionCache.get(code);
  if (cached) return cached;
  const sections = splitSections(code).map(parseSection);
  if (sectionCache.size > 500) sectionCache.clear();
  sectionCache.set(code, sections);
  return sections;
}

export function isDateFormat(code: string): boolean {
  if (/^general$/i.test(code)) return false;
  return parseFormat(code).some((section) => section.isDate);
}

/** Rounds half away from zero at a decimal place, avoiding binary artifacts like 1.005. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const isNumeric = (piece: Piece) => piece.k === "digit" || piece.k === "point" || piece.k === "exp" || piece.k === "comma";
const edge = (pieces: Piece[]): string =>
  pieces.map((piece) => (piece.k === "lit" ? piece.v : piece.k === "percent" ? "%" : "")).join("");

/**
 * One section of a number format applied to |value|. The sign is the caller's
 * business: a lone section shows "-", a negative section carries its own
 * parentheses or colour.
 */
function formatNumberSection(value: number, section: Section, withSign: boolean): string {
  const pieces = section.pieces;
  const first = pieces.findIndex(isNumeric);
  const lastNumeric = (() => {
    for (let index = pieces.length - 1; index >= 0; index--) if (isNumeric(pieces[index]!)) return index;
    return -1;
  })();
  const sign = withSign && value < 0 ? "-" : "";
  // A section with no placeholders is only text, such as the "zero" in 0;-0;"zero".
  if (first < 0) return edge(pieces);
  const head = edge(pieces.slice(0, first));
  const tail = edge(pieces.slice(lastNumeric + 1));
  const core = pieces.slice(first, lastNumeric + 1);
  const hasPercent = pieces.some((piece) => piece.k === "percent");

  const exponentAt = core.findIndex((piece) => piece.k === "exp");
  const mantissa = exponentAt < 0 ? core : core.slice(0, exponentAt);
  const exponent = exponentAt < 0 ? null : (core[exponentAt] as Extract<Piece, { k: "exp" }>);
  const pointAt = mantissa.findIndex((piece) => piece.k === "point");
  const intCore = pointAt < 0 ? mantissa : mantissa.slice(0, pointAt);
  const fracCore = pointAt < 0 ? [] : mantissa.slice(pointAt + 1);

  // Commas after the last digit placeholder scale by 1000; commas between digits group.
  const lastDigit = mantissa.map((piece) => piece.k).lastIndexOf("digit");
  let scale = 0;
  let grouping = false;
  mantissa.forEach((piece, index) => {
    if (piece.k !== "comma") return;
    if (index < lastDigit) grouping = true;
    else scale++;
  });
  let n = Math.abs(value);
  if (hasPercent) n *= 100;
  n /= 1000 ** scale;

  const fracDigits = fracCore.filter((piece) => piece.k === "digit") as Extract<Piece, { k: "digit" }>[];
  const decimals = fracDigits.length;
  let exponentText = "";
  if (exponent) {
    const intPlaceholders = intCore.filter((piece) => piece.k === "digit").length || 1;
    let power = n === 0 ? 0 : Math.floor(Math.log10(n));
    if (intPlaceholders > 1) power -= ((power % intPlaceholders) + intPlaceholders) % intPlaceholders;
    n /= 10 ** power;
    const width = core.slice(exponentAt + 1).filter((piece) => piece.k === "digit").length || 1;
    exponentText = `E${power < 0 ? "-" : exponent.sign === "+" ? "+" : ""}${String(Math.abs(power)).padStart(width, "0")}`;
  }
  const rounded = roundTo(n, decimals);
  const [intRaw = "0", fracRaw = ""] = rounded.toFixed(decimals).split(".");

  // Integer part.
  const intPlaceholders = intCore.filter((piece): piece is Extract<Piece, { k: "digit" }> => piece.k === "digit");
  const mustShowZero = intPlaceholders.some((piece) => piece.v === "0");
  let digits = intRaw === "0" && !mustShowZero ? "" : intRaw;
  const hasInnerLiterals = intCore.some((piece) => piece.k === "lit");
  let intText: string;
  if (hasInnerLiterals) {
    // 000-00-0000: walk the placeholders from the right so literals stay between their digits.
    const out: string[] = [];
    let left = digits;
    let remaining = intPlaceholders.length;
    for (let index = intCore.length - 1; index >= 0; index--) {
      const piece = intCore[index]!;
      if (piece.k === "lit") out.unshift(piece.v);
      else if (piece.k === "digit") {
        remaining--;
        let char = left.slice(-1);
        left = left.slice(0, -1);
        if (remaining === 0) char = left + char;
        out.unshift(char || (piece.v === "0" ? "0" : piece.v === "?" ? " " : ""));
      }
    }
    intText = out.join("");
  } else {
    const minimum = intPlaceholders.filter((piece) => piece.v === "0").length;
    const spaces = intPlaceholders.filter((piece) => piece.v === "?").length;
    digits = digits.padStart(minimum, "0");
    if (grouping && digits) digits = groupThousands(digits);
    intText = digits.padStart(digits.length + (digits ? 0 : 0), " ");
    if (spaces && digits.replace(/,/g, "").length < minimum + spaces) intText = " ".repeat(Math.max(0, minimum + spaces - digits.replace(/,/g, "").length)) + digits;
  }

  // Fraction part: trailing optional digits that are zero disappear.
  let fracText = "";
  if (pointAt >= 0) {
    const kept: string[] = [];
    let used = 0;
    for (const piece of fracCore) {
      if (piece.k === "digit") kept.push(fracRaw[used++] ?? "0");
      else if (piece.k === "lit") kept.push(piece.v);
    }
    const kinds = fracDigits.map((piece) => piece.v);
    let digitIndex = kinds.length;
    for (let index = kept.length - 1; index >= 0 && digitIndex > 0; index--) {
      if (!/^[0-9]$/.test(kept[index]!)) continue;
      digitIndex--;
      const kind = kinds[digitIndex]!;
      if (kind === "0" || kept[index] !== "0") break;
      kept[index] = kind === "?" ? " " : "";
    }
    fracText = "." + kept.join("");
  }
  return `${sign}${head}${intText}${fracText}${exponentText}${hasPercent && !head.includes("%") && !tail.includes("%") ? "%" : ""}${tail}`;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

const lastToken = (pieces: Piece[], from: number): string | null => {
  for (let index = from; index >= 0; index--) {
    const piece = pieces[index]!;
    if (piece.k === "date" || piece.k === "elapsed") return piece.v;
  }
  return null;
};
const nextToken = (pieces: Piece[], from: number): string | null => {
  for (let index = from; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if (piece.k === "date" || piece.k === "elapsed") return piece.v;
  }
  return null;
};

function formatDateSection(value: number, section: Section, date1904: boolean): string {
  if (value < 0) return "#".repeat(10);
  const pieces = section.pieces;
  const hasAmPm = pieces.some((piece) => piece.k === "ampm");
  let fractionalDigits = 0;
  for (let index = 0; index < pieces.length - 1; index++) {
    const piece = pieces[index]!;
    if (piece.k === "date" && piece.v.startsWith("s") && pieces[index + 1]!.k === "point") {
      let count = 0;
      for (let next = index + 2; next < pieces.length && pieces[next]!.k === "digit"; next++) count++;
      fractionalDigits = count;
    }
  }
  // Round to the displayed precision first, so 0.99999 s does not show as 60.
  const totalSeconds = Math.round(value * 86400 * 10 ** fractionalDigits) / 10 ** fractionalDigits;
  const dayPart = Math.floor(totalSeconds / 86400);
  const secondsOfDay = totalSeconds - dayPart * 86400;
  const date = serialToDate(dayPart, date1904);
  const hours24 = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  const seconds = Math.floor(secondsOfDay % 60);
  const sub = secondsOfDay - Math.floor(secondsOfDay);
  const out: string[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if (piece.k === "lit") out.push(piece.v);
    else if (piece.k === "ampm") {
      const long = piece.v.toUpperCase() === "AM/PM";
      out.push(hours24 < 12 ? (long ? "AM" : "A") : long ? "PM" : "P");
    } else if (piece.k === "elapsed") {
      const total = piece.v === "h" ? Math.floor(totalSeconds / 3600) : piece.v === "m" ? Math.floor(totalSeconds / 60) : Math.floor(totalSeconds);
      out.push(pad(total, piece.n));
    } else if (piece.k === "point") {
      let count = 0;
      for (let next = index + 1; next < pieces.length && pieces[next]!.k === "digit"; next++) count++;
      if (count && index > 0 && pieces[index - 1]!.k === "date") {
        out.push("." + sub.toFixed(count).slice(2));
        index += count;
      } else out.push(".");
    } else if (piece.k === "date") {
      const token = piece.v;
      if (token[0] === "y") out.push(token === "yy" ? pad(date.getUTCFullYear() % 100) : String(date.getUTCFullYear()));
      else if (token[0] === "d") {
        if (token === "d") out.push(String(date.getUTCDate()));
        else if (token === "dd") out.push(pad(date.getUTCDate()));
        else if (token === "ddd") out.push(DAYS[date.getUTCDay()]!.slice(0, 3));
        else out.push(DAYS[date.getUTCDay()]!);
      } else if (token[0] === "h") {
        const h = hasAmPm ? ((hours24 + 11) % 12) + 1 : hours24;
        out.push(token === "hh" ? pad(h) : String(h));
      } else if (token[0] === "s") out.push(token === "ss" ? pad(seconds) : String(seconds));
      else if (token[0] === "m") {
        // m after h, or before s, is minutes; otherwise it is the month.
        const before = lastToken(pieces, index - 1);
        const after = nextToken(pieces, index + 1);
        if (before?.startsWith("h") || after?.startsWith("s")) out.push(token === "mm" ? pad(minutes) : String(minutes));
        else {
          const month = date.getUTCMonth();
          if (token === "m") out.push(String(month + 1));
          else if (token === "mm") out.push(pad(month + 1));
          else if (token === "mmm") out.push(MONTHS[month]!.slice(0, 3));
          else if (token === "mmmm") out.push(MONTHS[month]!);
          else out.push(MONTHS[month]![0]!);
        }
      }
    }
  }
  return out.join("");
}

export function resolveFormatCode(numFmtId: number, custom: Map<number, string>): string {
  return custom.get(numFmtId) ?? BUILT_IN_FORMATS[numFmtId] ?? "General";
}

export function formatValue(value: Scalar, code: string, date1904 = false): Formatted {
  if (isError(value)) return { text: value.code, isText: true };
  if (value === null) return { text: "", isText: false };
  const general = !code || /^general$/i.test(code);
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", isText: true };
  if (typeof value === "string") {
    if (general) return { text: value, isText: true };
    const sections = parseFormat(code);
    const textSection = sections.length >= 4 ? sections[3]! : sections.find((section) => section.pieces.some((piece) => piece.k === "text"));
    if (textSection) {
      return {
        text: textSection.pieces.map((piece) => (piece.k === "text" ? value : piece.k === "lit" ? piece.v : "")).join(""),
        color: textSection.color,
        isText: true,
      };
    }
    return { text: value, isText: true };
  }
  if (general) {
    if (!Number.isFinite(value)) return { text: "#NUM!", isText: false };
    // General fits what a default column shows: about 11 significant digits.
    return { text: numberToText(Number(value.toPrecision(11))), isText: false };
  }
  const sections = parseFormat(code);
  let chosen = sections[0]!;
  let withSign = true;
  if (sections.some((section) => section.condition)) {
    chosen = sections.find((section) => section.condition?.(value)) ?? sections[sections.length - 1]!;
  } else if (value < 0 && sections.length >= 2) {
    chosen = sections[1]!;
    withSign = false;
  } else if (value === 0 && sections.length >= 3) chosen = sections[2]!;
  const text = chosen.isDate ? formatDateSection(value, chosen, date1904) : formatNumberSection(value, chosen, withSign);
  return { text, color: chosen.color, isText: false };
}
