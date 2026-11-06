"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { cellName, colName } from "./address";
import { cellLook } from "./cell-look";
import {
  HEADER_HEIGHT,
  HEADER_WIDTH,
  cellBox,
  indexAt,
  resolveCorner,
  scrollToReveal,
  span,
  step,
  visibleWindow,
  type Metrics,
} from "./grid-metrics";
import type { Rect, SheetSession } from "./sheet-session";
import { cellKey, type Border, type SheetModel } from "./workbook";

export interface CellPos {
  row: number;
  col: number;
}
export interface Selection {
  anchor: CellPos;
  focus: CellPos;
}
export interface Editing {
  row: number;
  col: number;
  text: string;
  source: "grid" | "bar";
}
export type Move = "down" | "up" | "right" | "left" | "stay";

const GRID = "#e4e4e7";
const HEADER_BG = "#f6f6f7";
const HEADER_FG = "#6b7280";
const INK = "#18181b";
const ACCENT = "var(--primary)";

/** The selected cells as a normalized range, grown to include any merged cell it touches. */
export function selectionRect(selection: Selection, m: Metrics): Rect {
  let rect: Rect = {
    r1: Math.min(selection.anchor.row, selection.focus.row),
    c1: Math.min(selection.anchor.col, selection.focus.col),
    r2: Math.max(selection.anchor.row, selection.focus.row),
    c2: Math.max(selection.anchor.col, selection.focus.col),
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const merge of m.mergeAt.values()) {
      const touches = merge.r1 <= rect.r2 && merge.r2 >= rect.r1 && merge.c1 <= rect.c2 && merge.c2 >= rect.c1;
      if (!touches) continue;
      const next = { r1: Math.min(rect.r1, merge.r1), c1: Math.min(rect.c1, merge.c1), r2: Math.max(rect.r2, merge.r2), c2: Math.max(rect.c2, merge.c2) };
      if (next.r1 !== rect.r1 || next.c1 !== rect.c1 || next.r2 !== rect.r2 || next.c2 !== rect.c2) {
        rect = next;
        changed = true;
      }
    }
  }
  return rect;
}

function borderCss(border: Border | null): string | undefined {
  if (!border) return undefined;
  const style = border.style;
  const width = /thick/.test(style) ? 3 : /medium/.test(style) ? 2 : 1;
  const line = /dash|dot/i.test(style) ? (/dot/i.test(style) && !/dash/i.test(style) ? "dotted" : "dashed") : style === "double" ? "double" : style === "hair" ? "dotted" : "solid";
  return `${style === "double" ? 3 : width}px ${line} ${border.color}`;
}

const pointSize = (points: number): number => Math.round(((points * 96) / 72) * 2) / 2;
const estimateWidth = (text: string, px: number, bold: boolean): number => text.length * px * (bold ? 0.6 : 0.55);

interface Props {
  session: SheetSession;
  sheet: SheetModel;
  /** Changes whenever cells change, so the grid redraws. */
  revision: number;
  selection: Selection;
  editing: Editing | null;
  readOnly: boolean;
  showGridLines?: boolean;
  label: string;
  /** Pixel geometry of the sheet; the container builds it because it also needs it to move the selection. */
  metrics: Metrics;
  focusRef: { current: (() => void) | null };
  onSelect(selection: Selection): void;
  onStartEdit(edit: Editing): void;
  onEditText(text: string): void;
  onCommit(move: Move): void;
  onCancel(): void;
  onClear(): void;
  onPaste(text: string): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
}

export function SheetGrid(props: Props) {
  const { session, sheet, selection, editing, readOnly } = props;
  const calc = session.calc;
  const m = props.metrics;
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 720, height: 480 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const scrollRef = useRef({ left: 0, top: 0 });
  const frame = useRef(0);
  const layers = {
    rows: useRef<HTMLDivElement>(null),
    cols: useRef<HTMLDivElement>(null),
    corner: useRef<HTMLDivElement>(null),
    colHeaders: useRef<HTMLDivElement>(null),
    rowHeaders: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Frozen panes stay put by moving with the scroll offset. This runs on every scroll event
  // and every render, outside React state, so there is no frame where they lag behind.
  const applyOffsets = useCallback(() => {
    const { left, top } = scrollRef.current;
    if (layers.rows.current) layers.rows.current.style.transform = `translateY(${top}px)`;
    if (layers.cols.current) layers.cols.current.style.transform = `translateX(${left}px)`;
    if (layers.corner.current) layers.corner.current.style.transform = `translate(${left}px, ${top}px)`;
    if (layers.colHeaders.current) layers.colHeaders.current.style.transform = `translateX(${left}px)`;
    if (layers.rowHeaders.current) layers.rowHeaders.current.style.transform = `translateY(${top}px)`;
  }, [layers.rows, layers.cols, layers.corner, layers.colHeaders, layers.rowHeaders]);
  useLayoutEffect(applyOffsets);

  const onScroll = () => {
    const element = viewport.current!;
    scrollRef.current = { left: element.scrollLeft, top: element.scrollTop };
    applyOffsets();
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setScroll({ ...scrollRef.current });
      });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Let the parent hand keyboard focus back after an edit or a formula-bar commit.
  useEffect(() => {
    props.focusRef.current = () => viewport.current?.focus({ preventScroll: true });
    const ref = props.focusRef;
    return () => {
      ref.current = null;
    };
  }, [props.focusRef]);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing && (document.activeElement === document.body || document.activeElement === null)) viewport.current?.focus({ preventScroll: true });
    wasEditing.current = editing !== null;
  }, [editing]);

  const rect = selectionRect(selection, m);
  const active = resolveCorner(m, selection.anchor.row, selection.anchor.col);

  // Keep the active cell in view after keyboard moves.
  const lastFocus = useRef("");
  useEffect(() => {
    const id = `${selection.focus.row},${selection.focus.col}`;
    if (id === lastFocus.current) return;
    lastFocus.current = id;
    const element = viewport.current;
    if (!element) return;
    const target = resolveCorner(m, selection.focus.row, selection.focus.col);
    const to = scrollToReveal(m, target.row, target.col, element.scrollLeft, element.scrollTop, size.width - HEADER_WIDTH, size.height - HEADER_HEIGHT);
    if (to) element.scrollTo({ left: to.left, top: to.top });
  }, [selection.focus.row, selection.focus.col, m, size.width, size.height]);

  const win = visibleWindow(m, scroll.left, scroll.top, size.width - HEADER_WIDTH, size.height - HEADER_HEIGHT);
  const scrollRows = span(0, win.r1, win.r2);
  const scrollCols = span(0, win.c1, win.c2);
  const frozenRows = span(m.freezeRows, 0, -1);
  const frozenCols = span(m.freezeCols, 0, -1);
  const totalWidth = m.x[m.cols]!;
  const totalHeight = m.y[m.rows]!;
  const frozenWidth = m.x[m.freezeCols]!;
  const frozenHeight = m.y[m.freezeRows]!;

  /* ---------------------------------------------------------------- cells */
  const renderCell = (row: number, col: number): ReactNode => {
    const key = cellKey(row, col);
    if (m.coveredBy.has(key)) return null;
    const cell = sheet.cells.get(key);
    const merge = m.mergeAt.get(key);
    const isActive = row === active.row && col === active.col;
    const style = session.workbook.styles.resolve(cell?.style ?? 0);
    const look = cellLook(session.workbook, sheet, row, col, style);
    // Empty cells are drawn only when something shows: a merge, the selection, or a table's banding.
    if (!cell && !merge && !isActive && !look.fill && !look.borderTop && !look.borderBottom) return null;
    const box = cellBox(m, row, col);
    if (box.width <= 0 || box.height <= 0) return null;
    const formatted = cell ? calc.format(sheet, row, col) : { text: "", isText: false };
    const value = cell ? calc.value(sheet, row, col) : null;
    const px = pointSize(style.fontSize);
    const isNumber = typeof value === "number";
    let text = formatted.text;
    const horizontal = style.horizontal && style.horizontal !== "general" ? style.horizontal : isNumber ? "right" : typeof value === "string" ? "left" : value === null ? "left" : "center";
    // A number that does not fit shows ###, as it does in Excel, never a clipped digit string.
    if (isNumber && text && estimateWidth(text, px, look.bold) > box.width - 4) text = "#".repeat(Math.max(1, Math.floor((box.width - 4) / (px * 0.6))));
    // Plain text runs on across the empty cells to its right.
    let spill = 0;
    if (typeof value === "string" && horizontal === "left" && !style.wrap && text && estimateWidth(text, px, look.bold) > box.width - 6) {
      for (let c = col + (merge ? merge.c2 - merge.c1 + 1 : 1); c < m.cols && spill < 1200; c++) {
        const next = sheet.cells.get(cellKey(row, c));
        if (m.coveredBy.has(cellKey(row, c)) || (next && (next.value !== null || next.formula !== undefined))) break;
        spill += m.x[c + 1]! - m.x[c]!;
        if (spill + box.width > estimateWidth(text, px, look.bold) + 8) break;
      }
    }
    const css: CSSProperties = {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      background: look.fill ?? (merge ? "#ffffff" : undefined),
      color: formatted.color ?? look.color,
      fontFamily: `${style.fontName}, Arial, Helvetica, sans-serif`,
      fontSize: px,
      fontWeight: look.bold ? 700 : 400,
      fontStyle: style.italic ? "italic" : "normal",
      textDecoration: [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ") || undefined,
      borderLeft: borderCss(style.border.left),
      borderRight: borderCss(style.border.right),
      borderTop: borderCss(look.borderTop),
      borderBottom: borderCss(look.borderBottom),
      justifyContent: horizontal === "center" || horizontal === "centerContinuous" ? "center" : horizontal === "right" ? "flex-end" : "flex-start",
      alignItems: style.vertical === "top" ? "flex-start" : style.vertical === "center" ? "center" : "flex-end",
      paddingLeft: horizontal === "left" ? 4 + style.indent * 9 : 4,
      paddingRight: horizontal === "right" ? 4 + style.indent * 9 : 4,
    };
    const error = typeof value === "object" && value !== null;
    return (
      <div
        key={key}
        role="gridcell"
        id={`cell-${sheet.name}-${row}-${col}`}
        aria-rowindex={row + 1}
        aria-colindex={col + 1}
        aria-selected={row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2}
        data-cell={cellName(row, col)}
        className="absolute box-border flex"
        style={css}
      >
        <span
          className={cn("min-w-0", style.wrap ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "overflow-hidden whitespace-nowrap", error && "text-[#b91c1c]")}
          style={spill ? { width: box.width - 8 + spill, maxWidth: "none", flexShrink: 0, overflow: "hidden", position: "relative", zIndex: 1 } : undefined}
        >
          {text}
        </span>
      </div>
    );
  };

  const gridlines = (rows: number[], cols: number[]): ReactNode => {
    if (!(props.showGridLines ?? sheet.showGridLines) || !rows.length || !cols.length) return null;
    const left = m.x[cols[0]!]!;
    const right = m.x[cols[cols.length - 1]! + 1]!;
    const top = m.y[rows[0]!]!;
    const bottom = m.y[rows[rows.length - 1]! + 1]!;
    return (
      <>
        {rows.map((r) => (
          <div key={`h${r}`} data-gridline aria-hidden className="absolute" style={{ left, width: right - left, top: m.y[r + 1]! - 1, height: 1, background: GRID }} />
        ))}
        {cols.map((c) => (
          <div key={`v${c}`} data-gridline aria-hidden className="absolute" style={{ top, height: bottom - top, left: m.x[c + 1]! - 1, width: 1, background: GRID }} />
        ))}
      </>
    );
  };

  const selectionLayer = (
    <>
      {rect.r1 !== rect.r2 || rect.c1 !== rect.c2 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left: m.x[rect.c1], top: m.y[rect.r1], width: m.x[Math.min(rect.c2 + 1, m.cols)]! - m.x[rect.c1]!, height: m.y[Math.min(rect.r2 + 1, m.rows)]! - m.y[rect.r1]!, background: `color-mix(in oklab, ${ACCENT} 12%, transparent)`, border: `1px solid color-mix(in oklab, ${ACCENT} 50%, transparent)` }}
        />
      ) : null}
      {(() => {
        const box = cellBox(m, active.row, active.col);
        return <div aria-hidden className="pointer-events-none absolute z-[2]" style={{ left: box.left - 1, top: box.top - 1, width: box.width + 1, height: box.height + 1, border: `2px solid ${ACCENT}` }} />;
      })()}
    </>
  );

  const region = (rows: number[], cols: number[]): ReactNode => (
    <>
      {gridlines(rows, cols)}
      {rows.map((r) => (
        <div key={r} role="row" aria-rowindex={r + 1} className="contents">
          {cols.map((c) => renderCell(r, c))}
        </div>
      ))}
      {selectionLayer}
    </>
  );

  /* ------------------------------------------------------------- headers */
  const colHeader = (c: number) => {
    const selected = c >= rect.c1 && c <= rect.c2;
    const whole = selected && rect.r1 === 0 && rect.r2 >= sheet.rows - 1 && sheet.rows > 0;
    return (
      <div
        key={c}
        role="columnheader"
        aria-label={`Column ${colName(c)}`}
        data-col-header={c}
        className={cn("absolute box-border flex items-center justify-center border-b border-r text-[11px] font-medium select-none", selected && "font-semibold")}
        style={{ left: m.x[c], width: m.x[c + 1]! - m.x[c]!, height: HEADER_HEIGHT, borderColor: GRID, background: whole ? `color-mix(in oklab, ${ACCENT} 22%, ${HEADER_BG})` : selected ? `color-mix(in oklab, ${ACCENT} 12%, ${HEADER_BG})` : HEADER_BG, color: selected ? INK : HEADER_FG }}
      >
        {colName(c)}
      </div>
    );
  };
  const rowHeader = (r: number) => {
    const selected = r >= rect.r1 && r <= rect.r2;
    return (
      <div
        key={r}
        role="rowheader"
        aria-label={`Row ${r + 1}`}
        data-row-header={r}
        className={cn("absolute box-border flex items-center justify-center border-b border-r text-[11px] font-medium select-none", selected && "font-semibold")}
        style={{ top: m.y[r], height: m.y[r + 1]! - m.y[r]!, width: HEADER_WIDTH, borderColor: GRID, background: selected ? `color-mix(in oklab, ${ACCENT} 12%, ${HEADER_BG})` : HEADER_BG, color: selected ? INK : HEADER_FG }}
      >
        {r + 1}
      </div>
    );
  };

  /* --------------------------------------------------------------- input */
  /** The cell under a mouse position, from the viewport rather than the layers, so frozen panes need no special case. */
  const locate = (event: { clientX: number; clientY: number }): { row: number; col: number; area: "cell" | "colHeader" | "rowHeader" | "corner" } | null => {
    const element = viewport.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const vx = event.clientX - box.left;
    const vy = event.clientY - box.top;
    if (vx < 0 || vy < 0 || vx > element.clientWidth || vy > element.clientHeight) return null;
    const inRowHeader = vx < HEADER_WIDTH;
    const inColHeader = vy < HEADER_HEIGHT;
    const x = vx - HEADER_WIDTH;
    const y = vy - HEADER_HEIGHT;
    const contentX = x < frozenWidth ? Math.max(0, x) : x + element.scrollLeft;
    const contentY = y < frozenHeight ? Math.max(0, y) : y + element.scrollTop;
    const col = indexAt(m.x, contentX);
    const row = indexAt(m.y, contentY);
    return { row, col, area: inRowHeader && inColHeader ? "corner" : inColHeader ? "colHeader" : inRowHeader ? "rowHeader" : "cell" };
  };

  const dragging = useRef<null | "cell" | "col" | "row">(null);
  const selectWith = (to: { row: number; col: number }, extend: boolean, area: "cell" | "colHeader" | "rowHeader" | "corner") => {
    const lastRow = Math.max(0, sheet.rows - 1);
    const lastCol = Math.max(0, sheet.cols - 1);
    if (area === "corner") return props.onSelect({ anchor: { row: 0, col: 0 }, focus: { row: lastRow, col: lastCol } });
    if (area === "colHeader") {
      const anchor = extend ? selection.anchor.col : to.col;
      return props.onSelect({ anchor: { row: 0, col: anchor }, focus: { row: lastRow, col: to.col } });
    }
    if (area === "rowHeader") {
      const anchor = extend ? selection.anchor.row : to.row;
      return props.onSelect({ anchor: { row: anchor, col: 0 }, focus: { row: to.row, col: lastCol } });
    }
    const target = resolveCorner(m, to.row, to.col);
    props.onSelect(extend ? { anchor: selection.anchor, focus: target } : { anchor: target, focus: target });
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    // Clicks inside the cell editor belong to the editor.
    if ((event.target as HTMLElement).closest("input")) return;
    const at = locate(event);
    if (!at) return;
    if (editing) props.onCommit("stay");
    viewport.current?.focus({ preventScroll: true });
    dragging.current = at.area === "colHeader" ? "col" : at.area === "rowHeader" ? "row" : "cell";
    selectWith(at, event.shiftKey, at.area);
    const move = (moveEvent: globalThis.MouseEvent) => {
      const over = locate(moveEvent);
      if (!over || !dragging.current) return;
      if (dragging.current === "col") selectWith(over, true, "colHeader");
      else if (dragging.current === "row") selectWith(over, true, "rowHeader");
      else selectWith(over, true, "cell");
    };
    const up = () => {
      dragging.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const beginEdit = (text?: string) => {
    if (readOnly) return;
    const reason = session.lockedReason(sheet, active.row, active.col);
    if (reason) return;
    props.onStartEdit({ row: active.row, col: active.col, text: text ?? session.input(sheet, active.row, active.col), source: "grid" });
  };

  const onDoubleClick = (event: MouseEvent) => {
    const at = locate(event);
    if (at?.area === "cell") beginEdit();
  };

  const move = (dRow: number, dCol: number, extend: boolean) => {
    const from = extend ? resolveCorner(m, selection.focus.row, selection.focus.col) : active;
    const to = step(sheet, m, from.row, from.col, dRow, dCol);
    props.onSelect(extend ? { anchor: selection.anchor, focus: to } : { anchor: to, focus: to });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (editing) return;
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key;
    const page = Math.max(1, Math.floor((size.height - HEADER_HEIGHT) / 20) - 1);
    if (modifier) {
      if (key === "z" || key === "Z") {
        event.preventDefault();
        if (readOnly) return;
        return event.shiftKey ? props.onRedo() : props.onUndo();
      }
      if (key === "y" || key === "Y") {
        event.preventDefault();
        if (readOnly) return;
        return props.onRedo();
      }
      if (key === "s" || key === "S") {
        event.preventDefault();
        return props.onSave();
      }
      if (key === "a" || key === "A") {
        event.preventDefault();
        return props.onSelect({ anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, sheet.rows - 1), col: Math.max(0, sheet.cols - 1) } });
      }
      if (key === "Home") {
        event.preventDefault();
        return props.onSelect({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
      }
      if (key === "End") {
        event.preventDefault();
        const to = { row: Math.max(0, sheet.rows - 1), col: Math.max(0, sheet.cols - 1) };
        return props.onSelect({ anchor: to, focus: to });
      }
      if (key.startsWith("Arrow")) {
        // Jump to the edge of the used range in that direction.
        event.preventDefault();
        const to = { row: active.row, col: active.col };
        if (key === "ArrowUp") to.row = 0;
        if (key === "ArrowDown") to.row = Math.max(0, sheet.rows - 1);
        if (key === "ArrowLeft") to.col = 0;
        if (key === "ArrowRight") to.col = Math.max(0, sheet.cols - 1);
        return props.onSelect(event.shiftKey ? { anchor: selection.anchor, focus: to } : { anchor: to, focus: to });
      }
      return; // copy, cut and paste arrive as clipboard events
    }
    switch (key) {
      case "ArrowUp": event.preventDefault(); return move(-1, 0, event.shiftKey);
      case "ArrowDown": event.preventDefault(); return move(1, 0, event.shiftKey);
      case "ArrowLeft": event.preventDefault(); return move(0, -1, event.shiftKey);
      case "ArrowRight": event.preventDefault(); return move(0, 1, event.shiftKey);
      case "PageDown": event.preventDefault(); return move(page, 0, event.shiftKey);
      case "PageUp": event.preventDefault(); return move(-page, 0, event.shiftKey);
      case "Home": event.preventDefault(); return props.onSelect({ anchor: { row: active.row, col: 0 }, focus: { row: active.row, col: 0 } });
      case "End": event.preventDefault(); { const to = { row: active.row, col: Math.max(0, sheet.cols - 1) }; return props.onSelect({ anchor: to, focus: to }); }
      case "Tab": event.preventDefault(); return move(0, event.shiftKey ? -1 : 1, false);
      case "Enter": event.preventDefault(); return event.shiftKey ? move(-1, 0, false) : beginEdit();
      case "F2": event.preventDefault(); return beginEdit();
      case "Delete":
      case "Backspace":
        event.preventDefault();
        return readOnly ? undefined : props.onClear();
      case "Escape":
        return;
    }
    // Typing a character starts replacing the cell, as in a spreadsheet.
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      beginEdit(key);
    }
  };

  const onCopy = (event: ClipboardEvent, cut: boolean) => {
    if (editing) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", session.copyText(sheet, rect));
    if (cut && !readOnly) props.onClear();
  };
  const onPasteEvent = (event: ClipboardEvent) => {
    if (editing || readOnly) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    props.onPaste(text);
  };

  /* -------------------------------------------------------------- editor */
  const editorBox = (() => {
    if (!editing) return null;
    const box = cellBox(m, editing.row, editing.col);
    const left = box.left + (editing.col < m.freezeCols ? scroll.left : 0);
    const top = box.top + (editing.row < m.freezeRows ? scroll.top : 0);
    return { left, top, width: Math.max(box.width, 120), height: Math.max(box.height, 22) };
  })();
  const editorStyle = editing ? session.workbook.styles.resolve(sheet.cells.get(cellKey(editing.row, editing.col))?.style ?? 0) : null;

  const announcement = `${cellName(active.row, active.col)}. ${session.input(sheet, active.row, active.col) || "Empty"}`;

  return (
    <div
      ref={viewport}
      role="grid"
      tabIndex={0}
      aria-label={props.label}
      aria-rowcount={m.rows}
      aria-colcount={m.cols}
      aria-multiselectable
      aria-readonly={readOnly || undefined}
      aria-activedescendant={`cell-${sheet.name}-${active.row}-${active.col}`}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onCopy={(event) => onCopy(event, false)}
      onCut={(event) => onCopy(event, true)}
      onPaste={onPasteEvent}
      className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-white text-[13px] text-[#18181b] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ colorScheme: "light" }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div style={{ width: HEADER_WIDTH + totalWidth, height: HEADER_HEIGHT + totalHeight }} className="relative">
        {/* Column headers */}
        <div className="sticky top-0 z-30" style={{ height: HEADER_HEIGHT, width: HEADER_WIDTH + totalWidth }}>
          <div className="absolute top-0" style={{ left: HEADER_WIDTH, width: totalWidth, height: HEADER_HEIGHT }}>
            {scrollCols.map(colHeader)}
          </div>
          <div ref={layers.colHeaders} className="absolute top-0 z-[1]" style={{ left: HEADER_WIDTH, width: frozenWidth, height: HEADER_HEIGHT, background: HEADER_BG, boxShadow: frozenWidth ? "1px 0 0 rgba(0,0,0,.18)" : undefined }}>
            {frozenCols.map(colHeader)}
          </div>
          <div
            aria-hidden
            data-corner
            className="absolute left-0 top-0 z-[2] border-b border-r"
            style={{ width: HEADER_WIDTH, height: HEADER_HEIGHT, background: HEADER_BG, borderColor: GRID }}
          />
        </div>
        {/* Row headers and cells */}
        <div className="absolute left-0" style={{ top: HEADER_HEIGHT, width: HEADER_WIDTH + totalWidth, height: totalHeight }}>
          <div className="sticky left-0 z-20 float-left" style={{ width: HEADER_WIDTH, height: totalHeight }}>
            <div className="relative" style={{ width: HEADER_WIDTH, height: totalHeight }}>
              {scrollRows.map(rowHeader)}
              <div ref={layers.rowHeaders} className="absolute left-0 top-0 z-[1]" style={{ width: HEADER_WIDTH, height: frozenHeight, background: HEADER_BG, boxShadow: frozenHeight ? "0 1px 0 rgba(0,0,0,.18)" : undefined }}>
                {frozenRows.map(rowHeader)}
              </div>
            </div>
          </div>
          <div className="absolute top-0" style={{ left: HEADER_WIDTH, width: totalWidth, height: totalHeight }}>
            <div className="absolute inset-0">{region(scrollRows, scrollCols)}</div>
            {frozenHeight > 0 && (
              <div ref={layers.rows} className="absolute left-0 top-0 z-[3] overflow-hidden bg-white" style={{ width: totalWidth, height: frozenHeight, boxShadow: "0 1px 0 rgba(0,0,0,.18)" }}>
                {region(frozenRows, scrollCols)}
              </div>
            )}
            {frozenWidth > 0 && (
              <div ref={layers.cols} className="absolute left-0 top-0 z-[4] overflow-hidden bg-white" style={{ width: frozenWidth, height: totalHeight, boxShadow: "1px 0 0 rgba(0,0,0,.18)" }}>
                {region(scrollRows, frozenCols)}
              </div>
            )}
            {frozenWidth > 0 && frozenHeight > 0 && (
              <div ref={layers.corner} className="absolute left-0 top-0 z-[5] overflow-hidden bg-white" style={{ width: frozenWidth, height: frozenHeight, boxShadow: "1px 1px 0 rgba(0,0,0,.18)" }}>
                {region(frozenRows, frozenCols)}
              </div>
            )}
            {editing && editorBox && editorStyle && editing.source === "grid" && (
              <input
                aria-label={`Edit ${cellName(editing.row, editing.col)}`}
                autoFocus
                value={editing.text}
                onChange={(event) => props.onEditText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.onCommit(event.shiftKey ? "up" : "down");
                  } else if (event.key === "Tab") {
                    event.preventDefault();
                    props.onCommit(event.shiftKey ? "left" : "right");
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    props.onCancel();
                    viewport.current?.focus({ preventScroll: true });
                  }
                  event.stopPropagation();
                }}
                onFocus={(event) => {
                  const end = event.target.value.length;
                  event.target.setSelectionRange(end, end);
                }}
                onBlur={() => props.onCommit("stay")}
                spellCheck={false}
                autoComplete="off"
                className="absolute z-40 box-border border-2 bg-white px-1 outline-none"
                style={{ left: editorBox.left - 1, top: editorBox.top - 1, width: editorBox.width + 2, height: editorBox.height + 2, borderColor: ACCENT, fontFamily: `${editorStyle.fontName}, Arial, Helvetica, sans-serif`, fontSize: pointSize(editorStyle.fontSize), color: INK, boxShadow: "0 2px 8px rgba(0,0,0,.18)" }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
