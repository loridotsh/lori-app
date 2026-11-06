"use client";

import type { CloudFile } from "@lori-enterprise/contracts";
import { CheckIcon, CircleAlertIcon, Grid2X2Icon, InfoIcon, LoaderCircleIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ClientApiError } from "@/lib/client-api";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { BinaryCard, PdfPreview, contentUrl } from "../file-preview";
import { QuietStatus } from "../quiet-status";
import { cellName, parseRange } from "./address";
import { unreadableCells } from "./cell-look";
import { buildMetrics, resolveCorner, step } from "./grid-metrics";
import { SheetGrid, selectionRect, type Editing, type Move, type Selection } from "./sheet-grid";
import { SheetSession, type SaveTicket } from "./sheet-session";
import { WorkbookReadError } from "./xlsx-read";
import { WorkbookWriteError } from "./xlsx-write";

/** Bigger workbooks open as page images only; parsing them in the browser would stall the tab. */
const MAX_INTERACTIVE_BYTES = 12 * 1024 * 1024;
const AUTOSAVE_MS = 1500;

export interface SheetControl {
  dirty: boolean;
  save(): Promise<boolean>;
  downloadCopy(): void;
}

interface Props {
  file: CloudFile;
  /** True while Lori is working or the member cannot change files. */
  disabled: boolean;
  controlRef: { current: SheetControl | null };
  onDirtyChange?(dirty: boolean): void;
  onSaved(file: CloudFile): void;
  onFailure(failure: unknown): void;
  /** The stored file changed underneath the editor: the parent should reload its file list. */
  onStale(): void;
}

type Phase = { kind: "loading" } | { kind: "ready"; session: SheetSession } | { kind: "fallback"; reason: string };
type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string; conflict: boolean; retryable: boolean };

const origin = (): Selection => ({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

function explain(error: unknown): string {
  if (error instanceof WorkbookReadError) return error.message;
  if (error instanceof WorkbookWriteError) return error.message;
  return "This workbook could not be opened for editing.";
}

export function SpreadsheetPreview({ file, disabled, controlRef, onDirtyChange, onSaved, onFailure, onStale }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [view, setView] = useState<"sheet" | "pages">("sheet");
  // Editing guides are a viewer preference, never a change to the workbook's saved view.
  const [showGridLines, setShowGridLines] = useState(true);
  const [sheetIndex, setSheetIndex] = useState(0);
  const selections = useRef(new Map<string, Selection>());
  const [selection, setSelectionState] = useState<Selection>(origin());
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const commitPending = useRef<() => void>(() => {});
  const downloadPending = useRef<() => void>(() => {});
  const [notice, setNotice] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [changedUnderneath, setChangedUnderneath] = useState(false);
  const focusGrid = useRef<(() => void) | null>(null);

  const session = phase.kind === "ready" ? phase.session : null;
  const sessionRef = useRef<SheetSession | null>(null);
  sessionRef.current = session;
  // The version this editor last knew the stored file to be, updated by its own saves.
  const current = useRef(file);
  const knownHash = useRef<string | null>(null);
  const saving = useRef(false);
  const lastAttempt = useRef<{ requestId: string; key: string } | null>(null);

  const revision = useSyncExternalStore(
    session ? session.subscribe : subscribeNothing,
    session ? session.getRevision : zero,
    zero,
  );

  /* -------------------------------------------------------------- loading */
  const fileRef = useRef(file);
  fileRef.current = file;
  useEffect(() => {
    const target = fileRef.current;
    if (sessionRef.current && knownHash.current === target.sha256) return; // our own save, or nothing new
    if (sessionRef.current?.dirty || editingRef.current) {
      setChangedUnderneath(true);
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: "loading" });
    setChangedUnderneath(false);
    setSave({ kind: "idle" });
    setEditing(null);
    void (async () => {
      try {
        if (target.sizeBytes > MAX_INTERACTIVE_BYTES) {
          setPhase({ kind: "fallback", reason: "this workbook is too large to open for editing here" });
          return;
        }
        const response = await fetch(contentUrl(target.id), { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Let "Opening workbook" paint before the parse occupies the thread.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (controller.signal.aborted) return;
        const opened = new SheetSession(bytes);
        try {
          opened.calc.recalculateAll();
        } catch {
          /* Display falls back to the values stored in the file. */
        }
        knownHash.current = target.sha256;
        current.current = target;
        selections.current.clear();
        const shown = opened.workbook.sheets.filter((item) => !item.hidden);
        const start = (shown.length ? shown : opened.workbook.sheets).indexOf(opened.workbook.sheets[opened.workbook.activeSheet]!);
        setSheetIndex(Math.max(0, start));
        setSelectionState(origin());
        setPhase({ kind: "ready", session: opened });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase({ kind: "fallback", reason: error instanceof WorkbookReadError ? lowerFirst(explain(error).replace(/\.$/, "")) : "it could not be opened for editing" });
      }
    })();
    return () => controller.abort();
  }, [file.id, file.sha256]);

  /* ---------------------------------------------------------------- sheets */
  const sheets = useMemo(() => {
    if (!session) return [];
    const visible = session.workbook.sheets.filter((sheet) => !sheet.hidden);
    return visible.length ? visible : session.workbook.sheets;
  }, [session]);
  const sheet = sheets[Math.min(sheetIndex, Math.max(0, sheets.length - 1))];
  const metrics = useMemo(() => (sheet ? buildMetrics(sheet) : null), [sheet, sheet?.rows, sheet?.cols]);

  const select = useCallback(
    (next: Selection) => {
      setSelectionState(next);
      if (sheet) selections.current.set(sheet.name, next);
    },
    [sheet],
  );

  /* ---------------------------------------------------------------- saving */
  const doSave = useCallback(async (): Promise<boolean> => {
    commitPending.current();
    // A disabled/conflicted editor must retain its draft rather than close over it.
    if (editingRef.current) return false;
    const live = sessionRef.current;
    if (!live) return true;
    if (!live.dirty) return true;
    if (saving.current) return false;
    saving.current = true;
    setSave({ kind: "saving" });
    let ticket: SaveTicket;
    try {
      ticket = live.beginSave();
    } catch (error) {
      saving.current = false;
      const message = error instanceof WorkbookWriteError ? error.message : "This workbook could not be prepared for saving.";
      setSave({ kind: "error", message: `Not saved. ${message}`, conflict: false, retryable: false });
      return false;
    }
    try {
      const target = current.current;
      const hash = await sha256Hex(ticket.bytes);
      const key = `${target.version}:${target.sha256}:${hash}`;
      // The same bytes against the same version are a retry, so the server can tell it already has them.
      const requestId = lastAttempt.current?.key === key ? lastAttempt.current.requestId : crypto.randomUUID();
      lastAttempt.current = { requestId, key };
      const saved = await cloudApi<CloudFile>(
        `/files/${encodeURIComponent(target.id)}/content?requestId=${requestId}&expectedVersion=${target.version}&expectedHash=${target.sha256}`,
        { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Blob([new Uint8Array(ticket.bytes)], { type: "application/octet-stream" }) },
      );
      current.current = saved;
      knownHash.current = saved.sha256;
      live.markSaved(ticket);
      lastAttempt.current = null;
      setSave({ kind: "idle" });
      onSaved(saved);
      // Edits made during the request still need a save before the panel may close.
      return !live.dirty && !editingRef.current;
    } catch (failure) {
      const conflict = failure instanceof ClientApiError && failure.code === "cloud_file_conflict";
      const retryable = !(failure instanceof ClientApiError) || failure.status === 0 || failure.status >= 500;
      setSave({
        kind: "error",
        conflict,
        retryable,
        message: conflict
          ? "This file was changed somewhere else, so your edits were not saved over it."
          : retryable
            ? `Not saved. ${cloudError(failure)}`
            : `Not saved. ${cloudError(failure)}`,
      });
      onFailure(failure);
      return false;
    } finally {
      saving.current = false;
    }
  }, [onFailure, onSaved]);

  const dirty = !!session && (session.dirty || !!(editing && sheet && editing.text !== session.input(sheet, editing.row, editing.col)));
  useEffect(() => {
    controlRef.current = { dirty, save: doSave, downloadCopy: () => downloadPending.current() };
    onDirtyChange?.(dirty);
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, dirty, doSave, onDirtyChange]);
  // Closing the editor must not leave the panel believing a workbook is still unsaved.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Save a moment after the member stops editing, never while a cell is open for editing.
  useEffect(() => {
    if (!dirty || editing || save.kind !== "idle" || disabled || changedUnderneath) return;
    const timer = setTimeout(() => void doSave(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, editing, save.kind, disabled, changedUnderneath, doSave, revision]);

  const downloadCopy = () => {
    if (!session) return;
    try {
      // Include a draft preserved during a remote update in the member's copy.
      // This only changes the local session; conflict state still prevents autosave.
      const edit = editingRef.current;
      if (edit && sheet) {
        const refusal = session.apply(sheet, [{ row: edit.row, col: edit.col, text: edit.text }]);
        if (refusal) { setNotice(refusal); return; }
        editingRef.current = null;
        setEditing(null);
      }
      const bytes = session.beginSave().bytes;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.path.split("/").pop() ?? "workbook.xlsx";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setNotice(error instanceof WorkbookWriteError ? error.message : "The edited copy could not be prepared.");
    }
  };
  downloadPending.current = downloadCopy;

  /* --------------------------------------------------------------- editing */
  const readOnly = disabled || changedUnderneath || save.kind === "error" && save.conflict;
  const commit = useCallback(
    (move: Move) => {
      const live = sessionRef.current;
      if (!live || !sheet || !metrics) return;
      const edit = editingRef.current;
      if (!edit) return;
      if (readOnly) return;
      let refusal: string | null = null;
      if (edit.text !== live.input(sheet, edit.row, edit.col)) refusal = live.apply(sheet, [{ row: edit.row, col: edit.col, text: edit.text }]);
      setNotice(refusal ?? "");
      if (refusal) return;
      setEditing(null);
      editingRef.current = null;
      const delta = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1], stay: [0, 0] }[move];
      const to = delta[0] || delta[1] ? step(sheet, metrics, edit.row, edit.col, delta[0]!, delta[1]!) : resolveCorner(metrics, edit.row, edit.col);
      select({ anchor: to, focus: to });
      focusGrid.current?.();
    },
    [metrics, select, sheet, readOnly],
  );
  commitPending.current = () => commit("stay");

  const cancel = useCallback(() => {
    setEditing(null);
    editingRef.current = null;
    focusGrid.current?.();
  }, []);

  const active = metrics ? resolveCorner(metrics, selection.anchor.row, selection.anchor.col) : { row: 0, col: 0 };
  const locked = session && sheet ? session.lockedReason(sheet, active.row, active.col) : null;

  // Leaving a sheet commits what is being typed.
  const switchSheet = (index: number) => {
    if (editing) commit("stay");
    setSheetIndex(index);
    const next = sheets[index];
    setSelectionState((next && selections.current.get(next.name)) || origin());
    setNotice("");
  };

  const rect = metrics ? selectionRect(selection, metrics) : null;
  const nameBox = rect ? (rect.r1 === rect.r2 && rect.c1 === rect.c2 ? cellName(rect.r1, rect.c1) : `${cellName(rect.r1, rect.c1)}:${cellName(rect.r2, rect.c2)}`) : "";
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const barText = editing ? editing.text : session && sheet ? session.input(sheet, active.row, active.col) : "";
  const barCancelled = useRef(false);

  const stats = session?.calc.stats();
  // Styles of cells that exist do not change as values are typed, so this is worked out once per sheet.
  const unreadable = useMemo(() => (session && sheet ? unreadableCells(session.workbook, sheet) : { count: 0, first: [] as string[] }), [session, sheet]);
  const notes: string[] = [];
  if (unreadable.count)
    notes.push(
      `${unreadable.count === 1 ? "Text in " : `${unreadable.count} cells such as `}${unreadable.first.join(", ")} ${unreadable.count === 1 ? "is" : "are"} set to a colour that matches its background (white on white), so it cannot be read in Excel either. It is shown in dark ink here.`,
    );
  if (sheet && sheet.drawings > 0) notes.push("Charts and images on this sheet are not drawn here. They are kept when you save; open Pages to see them.");
  if (stats && stats.approximate > 0)
    notes.push(`${stats.approximate} formula${stats.approximate === 1 ? "" : "s"} use${stats.approximate === 1 ? "s" : ""} ${stats.unsupported.length ? stats.unsupported.join(", ") : "functions"} which this view cannot calculate. They show the values stored in the file until it is opened in Excel.`);
  if (stats?.circular) notes.push("A circular reference was found. Its cells show 0.");
  if (session && session.workbook.unsupported.length) notes.push(`This workbook has ${session.workbook.unsupported.join(" and ")}. They are kept as they are.`);
  if (notice) notes.unshift(notice);

  /* ------------------------------------------------------------------ view */
  if (phase.kind === "loading") return <QuietStatus>Opening workbook…</QuietStatus>;
  if (phase.kind === "fallback")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p role="note" className="flex items-start gap-2 border-b border-border/70 bg-secondary/40 px-4 py-2 text-xs leading-5 text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Showing each page as a picture because {phase.reason}.
        </p>
        <PdfPreview file={file} onStale={onStale} />
      </div>
    );
  if (!sheet || !metrics || !session)
    return <BinaryCard file={file} note="This workbook has no sheets to show." />;

  const showPages = async () => {
    if (editing) commit("stay");
    if (await doSave()) setView("pages");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-2">
        <div role="group" aria-label="Workbook view" className="flex items-center gap-0.5 rounded-md bg-secondary/50 p-0.5">
          <Button size="sm" variant={view === "sheet" ? "secondary" : "ghost"} className="h-7 px-2 text-xs" aria-pressed={view === "sheet"} onClick={() => setView("sheet")}>
            Sheet
          </Button>
          <Button size="sm" variant={view === "pages" ? "secondary" : "ghost"} className="h-7 px-2 text-xs" aria-pressed={view === "pages"} onClick={() => void showPages()}>
            Pages
          </Button>
        </div>
        <span className="flex-1" />
        {view === "sheet" && (
          <>
            <Button size="icon" variant={showGridLines ? "secondary" : "ghost"} className="size-7" aria-label="Gridlines" title="Gridlines" aria-pressed={showGridLines} onClick={() => setShowGridLines((shown) => !shown)}>
              <Grid2X2Icon aria-hidden className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label="Undo" title="Undo" disabled={!session.canUndo || readOnly} onClick={() => { if (editing) cancel(); session.undo(); }}>
              <Undo2Icon aria-hidden className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label="Redo" title="Redo" disabled={!session.canRedo || readOnly} onClick={() => session.redo()}>
              <Redo2Icon aria-hidden className="size-3.5" />
            </Button>
            <span role="status" className="ml-1 flex min-w-16 items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
              {save.kind === "saving" ? (
                <>
                  <LoaderCircleIcon aria-hidden className="size-3 motion-safe:animate-spin" />
                  Saving…
                </>
              ) : save.kind === "error" ? (
                <>
                  <CircleAlertIcon aria-hidden className="size-3 text-destructive" />
                  Not saved
                </>
              ) : dirty ? (
                "Unsaved changes"
              ) : (
                <>
                  <CheckIcon aria-hidden className="size-3" />
                  Saved
                </>
              )}
            </span>
          </>
        )}
      </div>

      {view === "pages" ? (
        <PdfPreview file={file} onStale={onStale} />
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/70 px-2 text-xs">
            <input
              aria-label="Selected cell"
              value={nameDraft ?? nameBox}
              onFocus={(event) => {
                setNameDraft(nameBox);
                event.target.select();
              }}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => setNameDraft(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setNameDraft(null);
                  focusGrid.current?.();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const target = parseRange((nameDraft ?? "").replace(/\$/g, "").toUpperCase());
                  if (target && target.r1 < metrics.rows && target.c1 < metrics.cols) {
                    select({ anchor: { row: target.r1, col: target.c1 }, focus: { row: Math.min(target.r2, metrics.rows - 1), col: Math.min(target.c2, metrics.cols - 1) } });
                    setNameDraft(null);
                    focusGrid.current?.();
                  }
                }
              }}
              className="h-6 w-20 shrink-0 rounded border border-transparent bg-transparent px-1.5 text-center font-medium outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span aria-hidden className="select-none px-1 text-muted-foreground">
              fx
            </span>
            <input
              aria-label="Formula bar"
              value={barText}
              readOnly={readOnly || !!locked}
              title={locked ?? undefined}
              spellCheck={false}
              autoComplete="off"
              onFocus={() => {
                if (!readOnly && !locked && !editingRef.current) setEditing({ row: active.row, col: active.col, text: session.input(sheet, active.row, active.col), source: "bar" });
              }}
              onChange={(event) => {
                if (editing) setEditing({ ...editing, text: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  barCancelled.current = false;
                  commit(event.shiftKey ? "up" : "down");
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  barCancelled.current = true;
                  cancel();
                }
              }}
              onBlur={() => {
                if (barCancelled.current) {
                  barCancelled.current = false;
                  return;
                }
                if (editingRef.current?.source === "bar") commit("stay");
              }}
              className="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring read-only:cursor-default"
            />
          </div>

          <SheetGrid
            session={session}
            sheet={sheet}
            metrics={metrics}
            revision={revision}
            selection={selection}
            editing={editing}
            readOnly={readOnly}
            showGridLines={showGridLines}
            label={`${sheet.name} in ${file.path.split("/").pop()}`}
            focusRef={focusGrid}
            onSelect={select}
            onStartEdit={(edit) => {
              setNotice("");
              setEditing(edit);
            }}
            onEditText={(text) => editing && setEditing({ ...editing, text })}
            onCommit={commit}
            onCancel={cancel}
            onClear={() => {
              if (!rect) return;
              const refusal = session.clear(sheet, rect);
              setNotice(refusal ?? "");
            }}
            onPaste={(text) => {
              const refusal = session.paste(sheet, active.row, active.col, text);
              setNotice(refusal ?? "");
            }}
            onUndo={() => session.undo()}
            onRedo={() => session.redo()}
            onSave={() => void doSave()}
          />

          {(save.kind === "error" || changedUnderneath) && (
            <div role="alert" className="shrink-0 space-y-2 border-t border-border px-3 py-2 text-xs leading-5">
              <p className="text-destructive">
                {save.kind === "error" ? save.message : "This file was changed somewhere else while you were editing."}
              </p>
              <div className="flex flex-wrap gap-2">
                {save.kind === "error" && save.retryable && !save.conflict && (
                  <Button size="sm" variant="outline" onClick={() => { setSave({ kind: "idle" }); void doSave(); }}>
                    Try again
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={downloadCopy}>
                  Download my copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm("Discard your unsaved edits and load the latest version?")) {
                      knownHash.current = null;
                      sessionRef.current = null;
                      setChangedUnderneath(false);
                      setSave({ kind: "idle" });
                      onStale();
                    }
                  }}
                >
                  Load latest version
                </Button>
              </div>
            </div>
          )}
          {notes.length > 0 && (
            <ul className="shrink-0 space-y-1 border-t border-border/70 bg-secondary/30 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
              {notes.map((note) => (
                <li key={note} className="flex items-start gap-1.5">
                  <InfoIcon aria-hidden className="mt-px size-3 shrink-0" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          )}
          <div role="tablist" aria-label="Sheets" className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-t border-border/70 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sheets.map((item, index) => {
              const selected = item === sheet;
              return (
                <button
                  key={item.name}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => switchSheet(index)}
                  className={cn(
                    "relative h-8 max-w-48 shrink-0 truncate rounded-t-md border-x border-t px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    selected ? "border-border bg-background font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {item.tabColor && <span aria-hidden className="absolute inset-x-2 top-0 h-0.5 rounded-b" style={{ background: item.tabColor }} />}
                  {item.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const subscribeNothing = () => () => {};
const zero = () => 0;
