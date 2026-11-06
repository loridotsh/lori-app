/**
 * Saves edits back into the original .xlsx. Only the cells that changed are rewritten; every
 * other part of the package (charts, images, themes, conditional formats, macros' absence...)
 * is carried across untouched, so the file stays what the author built.
 */
import { unzipSync, zipSync, type Zippable } from "fflate";
import { cellName } from "./address";
import { patchSheet, type CellPatches } from "./sheet-patch";
import { escapeAttribute, escapeText, scan, XmlSyntaxError } from "./sax";
import { isError, type Scalar } from "./values";
import { cellKey, keyCol, keyRow, type Calculator, type Cell, type SheetModel } from "./workbook";
import { LIMITS } from "./xlsx-read";

export class WorkbookWriteError extends Error {}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** The edits made since the workbook was opened or last saved. */
export interface Edits {
  /** Cells the member changed, by sheet. */
  cells: Map<SheetModel, Set<number>>;
}

interface SharedGroup {
  ref: string | null;
  members: Set<number>;
  master: number | null;
}

/** Excel stores numbers in full precision; a plain JS number round-trips exactly. */
const numberText = (value: number): string => String(value);

function valueXml(value: Scalar): { type: string | null; body: string } {
  if (value === null) return { type: null, body: "" };
  if (isError(value)) return { type: "e", body: `<v>${escapeText(value.code)}</v>` };
  if (typeof value === "boolean") return { type: "b", body: `<v>${value ? 1 : 0}</v>` };
  if (typeof value === "number") return { type: null, body: `<v>${numberText(value)}</v>` };
  return { type: "str", body: `<v>${escapeText(value)}</v>` };
}

function cellXml(row: number, col: number, cell: Cell, value: Scalar, shared: { si: number; ref: string | null; master: boolean } | null): string {
  const style = cell.style ? ` s="${cell.style}"` : "";
  const ref = cellName(row, col);
  if (cell.formula !== undefined) {
    const { type, body } = valueXml(value);
    const typeAttr = type ? ` t="${type}"` : "";
    const formula = shared
      ? shared.master
        ? `<f t="shared" si="${shared.si}"${shared.ref ? ` ref="${escapeAttribute(shared.ref)}"` : ""}>${escapeText(cell.formula)}</f>`
        : `<f t="shared" si="${shared.si}"/>`
      : cell.array
        ? `<f t="array" ref="${ref}">${escapeText(cell.formula)}</f>`
        : `<f>${escapeText(cell.formula)}</f>`;
    return `<c r="${ref}"${style}${typeAttr}>${formula}${body}</c>`;
  }
  if (value === null) return `<c r="${ref}"${style}/>`;
  if (isError(value)) return `<c r="${ref}"${style} t="e"><v>${escapeText(value.code)}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "number") return `<c r="${ref}"${style}><v>${numberText(value)}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeText(value)}</t></is></c>`;
}

/** Shared-formula groups as the original sheet declared them. */
function sharedGroups(xml: string): Map<number, SharedGroup> {
  const groups = new Map<number, SharedGroup>();
  let row = -1;
  let nextRow = 0;
  let nextCol = 0;
  let col = 0;
  for (const token of scan(xml)) {
    if (token.kind === "text" || token.kind === "close") continue;
    if (token.name === "row") {
      const declared = Number(token.attrs.r);
      row = Number.isInteger(declared) && declared >= 1 ? declared - 1 : nextRow;
      nextRow = row + 1;
      nextCol = 0;
    } else if (token.name === "c") {
      const match = token.attrs.r ? /^[A-Za-z]+/.exec(token.attrs.r) : null;
      col = nextCol;
      if (match) {
        col = 0;
        for (const ch of match[0].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
        col -= 1;
      }
      nextCol = col + 1;
    } else if (token.name === "f" && token.attrs.t === "shared") {
      const si = Number(token.attrs.si);
      const group = groups.get(si) ?? { ref: null, members: new Set<number>(), master: null };
      group.members.add(cellKey(row, col));
      if (token.attrs.ref) {
        group.ref = token.attrs.ref;
        group.master = cellKey(row, col);
      }
      groups.set(si, group);
    }
  }
  return groups;
}

function ensureSupported(xml: string, part: string): void {
  // Generated cells use the default namespace; a sheet that prefixes its elements would mix two.
  if (/<[A-Za-z_][\w.-]*:(?:worksheet|sheetData|row|c)[\s>/]/.test(xml)) throw new WorkbookWriteError(`${part} uses prefixed element names, which this editor does not rewrite.`);
}

/** The used range as the cells really are now (a cleared cell no longer counts), for <dimension>. */
function dimensionOf(sheet: SheetModel): string | null {
  let rows = 0;
  let cols = 0;
  for (const key of sheet.cells.keys()) {
    rows = Math.max(rows, keyRow(key) + 1);
    cols = Math.max(cols, keyCol(key) + 1);
  }
  for (const merge of sheet.merges) {
    rows = Math.max(rows, merge.r2 + 1);
    cols = Math.max(cols, merge.c2 + 1);
  }
  if (!rows || !cols) return null;
  return rows === 1 && cols === 1 ? "A1" : `A1:${cellName(rows - 1, cols - 1)}`;
}

function patchStyles(xml: string, added: { base: number; numFmtId: number }[]): string {
  if (!added.length) return xml;
  // Collect the raw <xf> elements of cellXfs so new styles can copy the one they are based on.
  let start = -1;
  let end = -1;
  let openEnd = -1;
  const raws: string[] = [];
  let depthXf = -1;
  let inCellXfs = false;
  for (const token of scan(xml)) {
    if (token.kind === "text") continue;
    if (token.name === "cellXfs") {
      if (token.kind === "open") {
        inCellXfs = true;
        start = token.start;
        openEnd = token.end;
      } else if (token.kind === "close") {
        end = token.start;
        inCellXfs = false;
      } else throw new WorkbookWriteError("The workbook's style table is empty.");
      continue;
    }
    if (!inCellXfs || token.name !== "xf") continue;
    if (token.kind === "self") raws.push(xml.slice(token.start, token.end));
    else if (token.kind === "open") depthXf = token.start;
    else if (depthXf >= 0) {
      raws.push(xml.slice(depthXf, token.end));
      depthXf = -1;
    }
  }
  if (start < 0 || end < 0) throw new WorkbookWriteError("The workbook has no style table to extend.");
  const originalCount = raws.length;
  const extra: string[] = [];
  for (const { base, numFmtId } of added) {
    const source = raws[base] ?? raws[0];
    if (!source) throw new WorkbookWriteError("A style this edit needs is missing.");
    let copy = /numFmtId\s*=\s*"/.test(source) ? source.replace(/numFmtId\s*=\s*"[^"]*"/, `numFmtId="${numFmtId}"`) : source.replace(/^<xf/, `<xf numFmtId="${numFmtId}"`);
    if (!/applyNumberFormat/.test(copy)) copy = copy.replace(/^<xf/, '<xf applyNumberFormat="1"');
    else copy = copy.replace(/applyNumberFormat\s*=\s*"[^"]*"/, 'applyNumberFormat="1"');
    raws.push(copy);
    extra.push(copy);
  }
  const openTag = xml.slice(start, openEnd).replace(/count\s*=\s*"\d+"/, `count="${originalCount + extra.length}"`);
  return xml.slice(0, start) + openTag + xml.slice(openEnd, end) + extra.join("") + xml.slice(end);
}

function patchWorkbook(xml: string): string {
  const calc = /<calcPr\b[^>]*?(\/?)>/.exec(xml);
  if (calc) {
    const tag = calc[0];
    const next = /fullCalcOnLoad\s*=/.test(tag) ? tag.replace(/fullCalcOnLoad\s*=\s*"[^"]*"/, 'fullCalcOnLoad="1"') : tag.replace(/^<calcPr/, '<calcPr fullCalcOnLoad="1"');
    return xml.replace(tag, next);
  }
  const after = xml.indexOf("</sheets>");
  if (after < 0) throw new WorkbookWriteError("The workbook has no sheet list to update.");
  const tail = xml.slice(after);
  const found = /<(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/.exec(tail);
  const at = after + (found ? found.index : tail.length);
  return `${xml.slice(0, at)}<calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
}

function dropCalcChain(files: Record<string, Uint8Array>): void {
  delete files["xl/calcChain.xml"];
  const types = files["[Content_Types].xml"];
  if (types) files["[Content_Types].xml"] = encoder.encode(decoder.decode(types).replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""));
  const rels = files["xl/_rels/workbook.xml.rels"];
  if (rels) files["xl/_rels/workbook.xml.rels"] = encoder.encode(decoder.decode(rels).replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""));
}

const STORED = /\.(png|jpe?g|gif|webp|zip|xlsx|docx|pptx|pdf)$/i;

export interface PreparedSave {
  bytes: Uint8Array;
  /** Call once the bytes are safely stored: the file now holds these calculated results. */
  commit(): void;
}

/** Like prepareSave, for callers that have already stored (or do not need to store) the result. */
export function writeWorkbook(original: Uint8Array, calc: Calculator, edits: Edits): Uint8Array {
  const prepared = prepareSave(original, calc, edits);
  prepared.commit();
  return prepared.bytes;
}

/**
 * Writes the workbook's edits (and recalculated formula results) into a copy of the original
 * package. Nothing in the model changes until commit(), so a failed upload can simply be retried.
 * Throws WorkbookWriteError for anything it cannot do safely.
 */
export function prepareSave(original: Uint8Array, calc: Calculator, edits: Edits): PreparedSave {
  const { workbook } = calc;
  let total = 0;
  const files = unzipSync(original, {
    filter(file) {
      total += file.originalSize;
      if (total > LIMITS.uncompressedBytes) throw new WorkbookWriteError("This workbook is too large to save from here.");
      return true;
    },
  });
  const order = Object.keys(files);

  // Formulas whose result changed since the file was written get their stored value refreshed.
  const refreshed = new Map<SheetModel, Set<number>>();
  for (const change of calc.recalculateAll()) {
    const keys = refreshed.get(change.sheet) ?? new Set<number>();
    keys.add(cellKey(change.row, change.col));
    refreshed.set(change.sheet, keys);
  }

  let touched = false;
  const committed: { sheet: SheetModel; row: number; col: number; value: Scalar }[] = [];
  for (const sheet of workbook.sheets) {
    const edited = edits.cells.get(sheet) ?? new Set<number>();
    const rewrite = new Set<number>([...edited, ...(refreshed.get(sheet) ?? [])]);
    if (!rewrite.size) continue;
    const bytes = files[sheet.part];
    if (!bytes) throw new WorkbookWriteError(`The sheet ${sheet.name} is missing from the package.`);
    const xml = decoder.decode(bytes);
    ensureSupported(xml, sheet.name);
    const groups = sharedGroups(xml);
    // Editing any member of a shared formula turns the whole group into ordinary formulas.
    const unshared = new Set<number>();
    for (const [si, group] of groups) if ([...group.members].some((key) => edited.has(key) || !sheet.cells.get(key)?.formula)) unshared.add(si);
    for (const si of unshared) for (const key of groups.get(si)!.members) rewrite.add(key);

    const patches: CellPatches = new Map();
    for (const key of rewrite) {
      const row = keyRow(key);
      const col = keyCol(key);
      const cell = sheet.cells.get(key);
      const inRow = patches.get(row) ?? new Map<number, string | null>();
      patches.set(row, inRow);
      if (!cell) {
        inRow.set(col, null);
        continue;
      }
      let shared: { si: number; ref: string | null; master: boolean } | null = null;
      if (cell.shared !== undefined && !unshared.has(cell.shared)) {
        const group = groups.get(cell.shared);
        if (group) shared = { si: cell.shared, ref: group.ref, master: group.master === key };
      }
      const value = cell.formula !== undefined ? calc.value(sheet, row, col) : cell.value;
      if (cell.formula !== undefined) committed.push({ sheet, row, col, value });
      inRow.set(col, cellXml(row, col, cell, value, shared));
    }
    try {
      files[sheet.part] = encoder.encode(patchSheet(xml, patches, dimensionOf(sheet)));
    } catch (error) {
      if (error instanceof XmlSyntaxError) throw new WorkbookWriteError(`The sheet ${sheet.name} could not be updated.`);
      throw error;
    }
    touched = true;
  }
  if (!touched && !workbook.styles.added.length) return { bytes: original, commit: () => {} };

  if (workbook.styles.added.length) {
    const styles = files["xl/styles.xml"];
    if (!styles) throw new WorkbookWriteError("The workbook has no style table.");
    files["xl/styles.xml"] = encoder.encode(patchStyles(decoder.decode(styles), workbook.styles.added));
  }
  const book = files["xl/workbook.xml"];
  if (!book) throw new WorkbookWriteError("The workbook definition is missing.");
  // Excel recalculates everything when it opens the file, so the cached values are never trusted over the formulas.
  files["xl/workbook.xml"] = encoder.encode(patchWorkbook(decoder.decode(book)));
  dropCalcChain(files);

  const zippable: Zippable = {};
  for (const name of order) {
    const data = files[name];
    if (data) zippable[name] = [data, { level: STORED.test(name) ? 0 : 6 }];
  }
  const styleCount = workbook.styles.added.length;
  return {
    bytes: zipSync(zippable),
    commit: () => {
      // The file now stores these results and styles, so later saves only add what changes after this one.
      calc.commit(committed);
      workbook.styles.commitAdded(styleCount);
    },
  };
}
