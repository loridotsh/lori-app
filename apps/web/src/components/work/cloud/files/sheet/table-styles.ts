/**
 * The look an Excel table gives its cells: a filled header, banded rows, a totals row. A workbook
 * that marks a block as a table and names a style (TableStyleMedium2...) stores none of this on the
 * cells, so without it a header whose text is white would be invisible. These are close
 * approximations of Excel's built-in styles, drawn from the workbook's own theme colours.
 */
import type { Border, SheetModel, TableModel } from "./workbook";

export interface Look {
  fill?: string;
  color?: string;
  bold?: boolean;
  borderTop?: Border;
  borderBottom?: Border;
}

const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();

/** Mixes a colour toward white by `amount` (0 keeps it, 1 is white). */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex.replace("#", ""));
  return `#${toHex(r + (255 - r) * amount)}${toHex(g + (255 - g) * amount)}${toHex(b + (255 - b) * amount)}`;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex.replace("#", "")).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const INK = "#18181B";
const PAPER = "#FFFFFF";
/** Text this close to its background cannot be read; the view shows it in whichever of ink or white stands out. */
export const UNREADABLE_BELOW = 1.6;

export function readableOn(background: string): string {
  return contrast(INK, background) >= contrast(PAPER, background) ? INK : PAPER;
}

const NEUTRAL = "#404040";
const STYLE = /^TableStyle(Light|Medium|Dark)(\d{1,2})$/;

export function tableAt(sheet: SheetModel, row: number, col: number): TableModel | undefined {
  for (const table of sheet.tables) {
    const b = table.bounds;
    if (row >= b.r1 && row <= b.r2 && col >= b.c1 && col <= b.c2) return table;
  }
  return undefined;
}

/** The table style's look for one cell, or null when the style is unknown or the cell is plain. */
export function tableLook(table: TableModel, row: number, col: number, theme: string[]): Look | null {
  const match = table.style ? STYLE.exec(table.style) : null;
  if (!match) return null;
  const family = match[1] as "Light" | "Medium" | "Dark";
  const n = Number(match[2]);
  // Styles come in groups of seven: one neutral and then one for each of the six accent colours.
  const slot = (n - 1) % 7;
  const group = Math.floor((n - 1) / 7);
  const accent = slot === 0 ? NEUTRAL : `#${theme[4 + slot - 1] ?? "4472C4"}`;
  const b = table.bounds;
  const headerRow = table.hasHeader ? b.r1 : -1;
  const totalsRow = table.hasTotals ? b.r2 : -1;
  const line = (width: string): Border => ({ style: width, color: accent });
  const look: Look = {};

  if (row === headerRow) {
    const filled = family === "Dark" || (family === "Medium" && group !== 2) || (family === "Light" && group === 1);
    if (filled) {
      look.fill = family === "Dark" ? "#262626" : accent;
      look.color = PAPER;
    } else {
      look.borderBottom = line("medium");
      look.color = INK;
      if (family === "Medium") look.borderTop = line("medium");
    }
    look.bold = true;
    return look;
  }
  if (row === totalsRow) {
    look.bold = true;
    look.borderTop = line("medium");
    return look;
  }
  const firstBody = headerRow >= 0 ? b.r1 + 1 : b.r1;
  // The gridline styles (Light 15-21) have no banding.
  const stripes = table.rowStripes && !(family === "Light" && group === 2);
  if (stripes && (row - firstBody) % 2 === 0) look.fill = lighten(accent, family === "Dark" ? 0.7 : family === "Light" ? 0.88 : 0.82);
  if (table.columnStripes && (col - b.c1) % 2 === 0) look.fill = lighten(accent, 0.85);
  if ((table.firstColumn && col === b.c1) || (table.lastColumn && col === b.c2)) look.bold = true;
  return look.fill || look.bold ? look : null;
}
