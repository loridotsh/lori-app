/** xl/styles.xml and the theme: fonts, fills, borders, number formats and the cell styles that combine them. */
import { child, childrenNamed, descendants, elementChildren } from "./dom";
import { resolveFormatCode } from "./numfmt";
import type { Border, ResolvedStyle, StyleTable } from "./workbook";

/** The legacy indexed palette (indexes 0-63). */
const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

const DEFAULT_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];

export interface ThemeColors {
  /** Indexed as spreadsheet theme indexes: 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4-9 accents, 10 hyperlink, 11 followed. */
  colors: string[];
}

export function parseTheme(xml: string | undefined): ThemeColors {
  if (!xml) return { colors: DEFAULT_THEME };
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const scheme = descendants(doc, "clrScheme")[0];
  if (!scheme) return { colors: DEFAULT_THEME };
  const pick = (name: string): string | null => {
    const swatch = elementChildren(child(scheme, name))[0];
    if (!swatch) return null;
    const value = swatch.getAttribute("val");
    return (value && /^[0-9A-Fa-f]{6}$/.test(value) ? value : swatch.getAttribute("lastClr")) || null;
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return { colors: order.map((name, index) => pick(name)?.toUpperCase() ?? DEFAULT_THEME[index]!) };
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();

/** Lightens (tint > 0) or darkens (tint < 0) a color the way Excel does, in HLS space. */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return toHex(l * 255).repeat(3);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return toHex(hue(p, q, h + 1 / 3) * 255) + toHex(hue(p, q, h) * 255) + toHex(hue(p, q, h - 1 / 3) * 255);
}

function color(element: Element | null | undefined, theme: ThemeColors): string | null {
  if (!element) return null;
  const rgb = element.getAttribute("rgb");
  if (rgb && /^[0-9A-Fa-f]{8}$/.test(rgb)) return `#${rgb.slice(2).toUpperCase()}`;
  if (rgb && /^[0-9A-Fa-f]{6}$/.test(rgb)) return `#${rgb.toUpperCase()}`;
  const tint = Number(element.getAttribute("tint") ?? 0) || 0;
  const themeIndex = element.getAttribute("theme");
  if (themeIndex !== null) {
    const base = theme.colors[Number(themeIndex)];
    return base ? `#${applyTint(base, tint)}` : null;
  }
  const indexed = element.getAttribute("indexed");
  if (indexed !== null) {
    const base = INDEXED[Number(indexed)];
    return base ? `#${applyTint(base, tint)}` : null;
  }
  return null;
}

interface Font {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
  name: string;
  color: string | null;
}
interface Xf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  horizontal: string | null;
  vertical: string | null;
  wrap: boolean;
  indent: number;
}

const children = childrenNamed;
const first = child;

export class Styles implements StyleTable {
  private readonly fonts: Font[] = [];
  private readonly fills: (string | null)[] = [];
  private readonly borders: ResolvedStyle["border"][] = [];
  private readonly xfs: Xf[] = [];
  private readonly cache = new Map<number, ResolvedStyle>();
  readonly custom = new Map<number, string>();
  readonly added: { base: number; numFmtId: number }[] = [];

  constructor(xml: string | undefined, theme: ThemeColors) {
    const defaultFont: Font = { bold: false, italic: false, underline: false, strike: false, size: 11, name: "Calibri", color: null };
    if (!xml) {
      this.fonts.push(defaultFont);
      this.fills.push(null);
      this.borders.push({ left: null, right: null, top: null, bottom: null });
      this.xfs.push({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, horizontal: null, vertical: null, wrap: false, indent: 0 });
      return;
    }
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const root = doc.documentElement;
    for (const format of children(first(root, "numFmts"), "numFmt")) {
      const id = Number(format.getAttribute("numFmtId"));
      const code = format.getAttribute("formatCode");
      if (Number.isFinite(id) && code !== null) this.custom.set(id, code);
    }
    for (const font of children(first(root, "fonts"), "font")) {
      const flag = (name: string) => {
        const element = first(font, name);
        return !!element && element.getAttribute("val") !== "0" && element.getAttribute("val") !== "false";
      };
      this.fonts.push({
        bold: flag("b"),
        italic: flag("i"),
        underline: !!first(font, "u") && first(font, "u")!.getAttribute("val") !== "none",
        strike: flag("strike"),
        size: Number(first(font, "sz")?.getAttribute("val")) || 11,
        name: first(font, "name")?.getAttribute("val") ?? "Calibri",
        color: color(first(font, "color"), theme),
      });
    }
    for (const fill of children(first(root, "fills"), "fill")) {
      const pattern = first(fill, "patternFill");
      const kind = pattern?.getAttribute("patternType");
      this.fills.push(pattern && kind === "solid" ? color(first(pattern, "fgColor"), theme) : null);
    }
    for (const border of children(first(root, "borders"), "border")) {
      const side = (name: string): Border | null => {
        const element = first(border, name);
        const style = element?.getAttribute("style");
        if (!element || !style || style === "none") return null;
        return { style, color: color(first(element, "color"), theme) ?? "#000000" };
      };
      this.borders.push({ left: side("left"), right: side("right"), top: side("top"), bottom: side("bottom") });
    }
    for (const xf of children(first(root, "cellXfs"), "xf")) {
      const alignment = first(xf, "alignment");
      this.xfs.push({
        numFmtId: Number(xf.getAttribute("numFmtId")) || 0,
        fontId: Number(xf.getAttribute("fontId")) || 0,
        fillId: Number(xf.getAttribute("fillId")) || 0,
        borderId: Number(xf.getAttribute("borderId")) || 0,
        horizontal: alignment?.getAttribute("horizontal") ?? null,
        vertical: alignment?.getAttribute("vertical") ?? null,
        wrap: alignment?.getAttribute("wrapText") === "1" || alignment?.getAttribute("wrapText") === "true",
        indent: Number(alignment?.getAttribute("indent")) || 0,
      });
    }
    if (!this.fonts.length) this.fonts.push(defaultFont);
    if (!this.xfs.length) this.xfs.push({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, horizontal: null, vertical: null, wrap: false, indent: 0 });
  }

  get count(): number {
    return this.xfs.length;
  }

  numFmtId(xf: number): number {
    return (this.xfs[xf] ?? this.xfs[0]!).numFmtId;
  }

  resolve(index: number): ResolvedStyle {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const xf = this.xfs[index] ?? this.xfs[0]!;
    const font = this.fonts[xf.fontId] ?? this.fonts[0]!;
    const resolved: ResolvedStyle = {
      numFmt: resolveFormatCode(xf.numFmtId, this.custom),
      bold: font.bold,
      italic: font.italic,
      underline: font.underline,
      strike: font.strike,
      fontSize: font.size,
      fontName: font.name,
      color: font.color,
      fill: this.fills[xf.fillId] ?? null,
      border: this.borders[xf.borderId] ?? { left: null, right: null, top: null, bottom: null },
      horizontal: xf.horizontal,
      vertical: xf.vertical,
      wrap: xf.wrap,
      indent: xf.indent,
    };
    this.cache.set(index, resolved);
    return resolved;
  }

  private readonly derived = new Map<string, number>();

  withNumFmt(base: number, numFmtId: number): number {
    const key = `${base}:${numFmtId}`;
    const existing = this.derived.get(key);
    if (existing !== undefined) return existing;
    const source = this.xfs[base] ?? this.xfs[0]!;
    this.xfs.push({ ...source, numFmtId });
    this.added.push({ base, numFmtId });
    this.derived.set(key, this.xfs.length - 1);
    return this.xfs.length - 1;
  }

  commitAdded(count: number): void {
    this.added.splice(0, count);
  }
}
