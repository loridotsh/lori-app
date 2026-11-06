"use client";

import { artifactDisplayName, isArtifactFile, parseArtifactFile, type CloudFile } from "@lori-enterprise/contracts";
import { CheckIcon, CircleAlertIcon, DownloadIcon, FileTextIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type RefObject,
  type CSSProperties,
} from "react";
import { CloudMarkdown } from "./cloud-markdown";
import { Button } from "@/components/ui/button";
import {
  cloudApi,
  cloudError,
  cloudMutation,
  cloudPath,
} from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { PreviewResizeHandle, usePreviewWidth } from "./files/preview-resize";
import {
  BinaryCard,
  ImagePreview,
  VideoPreview,
  PdfPreview,
  TablePreview,
  previewMode,
} from "./files/file-preview";
import { QuietStatus } from "./files/quiet-status";
import { SpreadsheetPreview, type SheetControl } from "./files/sheet/spreadsheet-preview";
import { ArtifactFilePreview } from "./files/artifact-file-preview";
import { loadFileText } from "./files/load-file-text";


/** Ask the panel to open a file by path; a new `nonce` repeats the request for the same path. */
export interface OpenRequest {
  path: string;
  nonce: number;
}

export function CloudFiles({
  conversationId,
  files,
  disabled,
  readOnly = false,
  allowExport = true,
  onFiles,
  onClose,
  onFailure,
  onDirtyChange,
  onBusyChange,
  returnFocusRef,
  openRequest = null,
}: {
  conversationId: string | null;
  files: CloudFile[];
  disabled: boolean;
  readOnly?: boolean;
  allowExport?: boolean;
  onFiles: (files: CloudFile[]) => void;
  onClose: () => void;
  onFailure: (failure: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  openRequest?: OpenRequest | null;
}) {
  const [selected, setSelected] = useState<CloudFile | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [notText, setNotText] = useState(false);
  const mode = selected ? (notText ? "binary" : previewMode(selected)) : null;
  const [text, setText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const visual = useMemo(() => selected && /\.json$/i.test(selected.path) && !truncated ? parseArtifactFile(text) : null, [selected, text, truncated]);
  const artifact = Boolean(selected && (isArtifactFile(selected.path) || visual));
  const alternateView =
    selected && mode === "text"
      ? artifact || /\.(md|markdown)$/i.test(selected.path)
        ? "Preview"
        : /\.(csv|tsv)$/i.test(selected.path)
          ? "Table"
          : null
      : null;
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  // Browsers normalize a textarea's line breaks to LF; a file that used CRLF keeps them when saved.
  const outgoing = savedText.includes("\r\n")
    ? text.replace(/\r?\n/g, "\r\n")
    : text;
  const textDirty =
    selected !== null && text !== savedText && outgoing !== savedText;
  // A workbook being edited reports its own unsaved state and saves itself.
  const sheetControl = useRef<SheetControl | null>(null);
  const [sheetDirty, setSheetDirty] = useState(false);
  const dirty = textDirty || (mode === "spreadsheet" && sheetDirty);
  // Read inside effects and callbacks that outlive a render; opening another file mid-save would orphan the save's own cleanup.
  const savingRef = useRef(false);
  savingRef.current = saving;
  const panel = useRef<HTMLElement>(null);
  const resize = usePreviewWidth(panel);
  const textRef = useRef(text);
  textRef.current = text;
  const closeButton = useRef<HTMLButtonElement>(null);
  const [overlay, setOverlay] = useState(
    () =>
      typeof window !== "undefined" &&
      !window.matchMedia("(min-width: 80rem)").matches,
  );
  const overlayCurrent = useRef(overlay);
  overlayCurrent.current = overlay;
  const requestClose = useRef(() => {});
  requestClose.current = () => {
    if (savingRef.current) return;
    void (async () => {
      if (dirty && !(await saveRef.current())) return;
      onClose();
    })();
  };
  useEffect(() => {
    const media = window.matchMedia("(min-width: 80rem)");
    const changed = () => setOverlay(!media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!overlay || !element) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background: Array<{ element: HTMLElement; inert: boolean }> = [];
    for (
      let branch: HTMLElement | null = element;
      branch?.parentElement;
      branch = branch.parentElement
    ) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      if (branch.parentElement === document.body) break;
    }
    const focusable = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (item) =>
          !item.closest("[hidden],[inert]") &&
          getComputedStyle(item).display !== "none" &&
          getComputedStyle(item).visibility !== "hidden",
      );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose.current();
      }
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        element.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target))
        closeButton.current?.focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    closeButton.current?.focus();
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      for (const item of background) item.element.inert = item.inert;
      if (overlayCurrent.current) {
        const target = returnFocusRef?.current ?? previous;
        if (target?.isConnected) target.focus();
      }
    };
  }, [overlay, returnFocusRef]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(loading || saving);
    return () => onBusyChange?.(false);
  }, [loading, saving, onBusyChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving]);
  const refresh = async (version: number) => {
    if (!conversationId) return;
    // Called after a save or delete the server already confirmed. A failed list
    // reload leaves the list stale, but must never turn that success into
    // "may have been saved"; the next open or reload corrects it.
    try {
      const next = await cloudApi<{ files: CloudFile[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/files`,
      );
      if (version === generation.current) onFiles(next.files);
    } catch {
      /* stale list only */
    }
  };
  useEffect(() => {
    let stale = false;
    setSelected(null);
    setView("edit");
    setNotText(false);
    setText("");
    setSavedText("");
    setTruncated(false);
    setLoading(false);
    setSaving(false);
    setUncertain(false);
    setError("");
    generation.current++;
    if (conversationId)
      void cloudApi<{ files: CloudFile[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/files`,
      )
        .then((next) => {
          if (!stale) onFiles(next.files);
        })
        .catch((failure) => {
          if (!stale) {
            setError(cloudError(failure));
            onFailure(failure);
          }
        });
    return () => {
      stale = true;
      generation.current++;
    };
  }, [conversationId]);
  const open = async (file: CloudFile, preview = true) => {
    const version = ++generation.current;
    setSelected(file);
    setView(preview && /\.(md|markdown|csv|tsv|json)$/i.test(file.path) ? "preview" : "edit");
    setNotText(false);
    setError("");
    setUncertain(false);
    setText("");
    setSavedText("");
    // Images, PDFs and office files have no text to load; they preview from the download.
    if (previewMode(file) !== "text") {
      setLoading(false);
      setTruncated(false);
      return;
    }
    setLoading(true);
    try {
      const content = await loadFileText(file, () => version === generation.current);
      if (content && version === generation.current) {
        setSelected(content.file);
        setText(content.text);
        setSavedText(content.text);
        setTruncated(content.truncated);
      }
    } catch (failure) {
      if (version === generation.current) {
        // An unknown extension can still hold binary data; show the download card, not an error.
        if (failure instanceof ClientApiError && failure.code === "cloud_file_not_text")
          setNotText(true);
        else {
          setError(cloudError(failure));
          onFailure(failure);
        }
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  // One in-flight write at a time. New keystrokes remain editable and are saved
  // against the returned version on the next pass, never against a stale hash.
  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (mode === "spreadsheet") return (await sheetControl.current?.save()) ?? true;
    if (!selected || savingRef.current || loading || disabled || readOnly || truncated || uncertain || error) return false;
    const version = generation.current;
    const submitted = text;
    savingRef.current = true;
    setSaving(true);
    try {
      const file = await cloudApi<CloudFile>(
        `/files/${encodeURIComponent(selected.id)}`,
        cloudMutation({ requestId: crypto.randomUUID(), expectedVersion: selected.version,
          expectedHash: selected.sha256, text: outgoing }, "PATCH"),
      );
      if (version !== generation.current) return false;
      setSelected(file);
      setSavedText(outgoing);
      await refresh(version);
      return version === generation.current && textRef.current === submitted;
    } catch (failure) {
      if (version !== generation.current) return false;
      setError(cloudError(failure));
      onFailure(failure);
      if (!(failure instanceof ClientApiError) || failure.status === 0 || failure.status >= 500)
        setUncertain(true);
      return false;
    } finally {
      if (version === generation.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!textDirty || saving || loading || disabled || readOnly || truncated || uncertain || error) return;
    const timer = setTimeout(() => void saveRef.current(), 650);
    return () => clearTimeout(timer);
  }, [textDirty, text, saving, loading, disabled, readOnly, truncated, uncertain, error]);

  // A rendered document is bound to one version of its file. When the file
  // changes underneath the panel, reload the list and reopen the same path.
  const reopenSelected = async () => {
    if (!conversationId || !selected) return;
    const path = selected.path;
    const version = generation.current;
    try {
      const next = await cloudApi<{ files: CloudFile[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/files`,
      );
      if (version !== generation.current) return;
      onFiles(next.files);
      const latest = next.files.find((file) => file.path === path);
      if (latest) await open(latest);
      else setError("That file is no longer in this conversation.");
    } catch (failure) {
      if (version !== generation.current) return;
      setError(cloudError(failure));
      onFailure(failure);
    }
  };
  const openRef = useRef(open);
  openRef.current = open;
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    setSelected((previous) => {
      if (!previous || previewMode(previous) === "text") return previous;
      const latest = files.find((file) => file.id === previous.id);
      return latest && latest.version > previous.version ? latest : previous;
    });
  }, [files]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!selected || !isArtifactFile(selected.path) || dirty || saving || loading || error) return;
    const latest = files.find(file => file.id === selected.id);
    if (latest && latest.version > selected.version) void openRef.current(latest);
  }, [files, selected, dirty, saving, loading, error]);
  const requested = useRef(0);
  const changeFile = async (file: CloudFile) => {
    if (savingRef.current) return;
    const request = ++requested.current;
    if (dirtyRef.current && !(await saveRef.current())) return;
    if (request === requested.current) await openRef.current(file);
  };
  const changeFileRef = useRef(changeFile);
  changeFileRef.current = changeFile;
  useEffect(() => {
    let stale = false;
    const request = ++requested.current;
    void (async () => {
      if (savingRef.current) return;
      if (dirtyRef.current && !(await saveRef.current())) return;
      if (stale || request !== requested.current) return;
      let available = filesRef.current;
      if (openRequest && !available.some((file) => file.path === openRequest.path)) {
        try {
          if (!conversationId) return;
          const result = await cloudApi<{ files: CloudFile[] }>(`/conversations/${encodeURIComponent(conversationId)}/files`);
          if (stale || request !== requested.current) return;
          available = result.files;
          onFiles(available);
        } catch (failure) {
          if (!stale) { setError(cloudError(failure)); onFailure(failure); }
          return;
        }
      }
      const target = openRequest
        ? available.find((file) => file.path === openRequest.path)
        : available.filter((file) => !file.path.startsWith(".trash/"))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (target) await openRef.current(target);
      else if (openRequest) setError("That file is no longer in this conversation.");
    })();
    return () => { stale = true; };
  }, [openRequest, conversationId]);
  const downloadDraft = () => {
    if (!selected) return;
    if (mode === "spreadsheet") {
      sheetControl.current?.downloadCopy();
      return;
    }
    const url = URL.createObjectURL(new Blob([outgoing], { type: selected.mimeType || "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selected.path.split("/").pop() ?? "draft.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const visibleFiles = files.filter((file) => !file.path.startsWith(".trash/"));
  const saveStatus = error ? "Not saved" : saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved";
  const fileDescription = selected
    ? `${selected.path} · ${formatSize(selected.sizeBytes)} · Version ${selected.version}`
    : "File preview";
  return (
    <aside
      data-conversation-find-ignore
      ref={panel}
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay ? true : undefined}
      tabIndex={overlay ? -1 : undefined}
      id="cloud-file-preview"
      aria-label="File preview"
      style={{ "--preview-width": `${resize.width}px` } as CSSProperties}
      className="fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background motion-safe:animate-fade-in xl:relative xl:inset-auto xl:z-20 xl:w-[var(--preview-width)] xl:shrink-0 xl:border-l xl:border-border"

    >
      {!overlay && <PreviewResizeHandle {...resize} />}
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/70 px-3">
        <div className="min-w-0 flex-1" title={fileDescription}>
          {visibleFiles.length > 1 ? (
            <select aria-label="Preview file" value={selected?.id ?? ""}
              disabled={saving} onChange={(event) => {
                const file = files.find((item) => item.id === event.target.value);
                if (file) void changeFileRef.current(file);
              }}
              className="block h-8 w-full min-w-0 truncate rounded bg-background pr-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {!selected && <option value="">Choose a file</option>}
              {visibleFiles.map((file) => <option key={file.id} value={file.id} title={file.path}>
                {file.id === selected?.id && visual ? visual.title : isArtifactFile(file.path) ? artifactDisplayName(file.path) : file.path}
              </option>)}
            </select>
          ) : <h2 className="truncate text-xs font-medium">{visual?.title ?? selected?.path.split("/").pop() ?? "File preview"}</h2>}
        </div>
        {selected && !loading && alternateView && (
          <div role="group" aria-label="File view" className="flex shrink-0 items-center gap-0.5 rounded-md bg-secondary/50 p-0.5">
            {(["preview", "edit"] as const).map((item) => (
              <Button key={item} size="sm" variant={view === item ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs" aria-pressed={view === item}
                onClick={() => setView(item)}>
                {item === "edit" ? "Edit" : alternateView}
              </Button>
            ))}
          </div>
        )}
        {selected && !loading && mode === "text" && (
          <span role="status" title={saveStatus} className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            {error ? <CircleAlertIcon aria-hidden className="size-3.5 text-destructive" />
              : saving ? <LoaderCircleIcon aria-hidden className="size-3.5 motion-safe:animate-spin" />
              : dirty ? <span aria-hidden className="size-1.5 rounded-full bg-current" />
              : <CheckIcon aria-hidden className="size-3.5" />}
            <span className="sr-only">{saveStatus}</span>
          </span>
        )}
        {selected && allowExport && <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <a href={`/api${cloudPath}/files/${encodeURIComponent(selected.id)}/content?download=true`}
            download aria-label="Download file" title={dirty ? "Download current draft" : "Download file"}
            onClick={(event) => { if (dirty) { event.preventDefault(); downloadDraft(); } }}>
            <DownloadIcon aria-hidden />
          </a>
        </Button>}
        <Button ref={closeButton} size="icon" variant="ghost" className="size-8 shrink-0"
          aria-label="Close preview" disabled={saving} onClick={() => requestClose.current()}>
          <XIcon aria-hidden />
        </Button>
      </header>
      {error && (
        <div className="px-4 py-3">
          <p role="alert" className="text-xs leading-5 text-destructive">
            {error}
          </p>
          {selected && !uncertain && !dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (
                  dirty &&
                  !window.confirm(
                    "Discard your unsaved file changes and load the latest version?",
                  )
                )
                  return;
                void open(selected);
              }}
            >
              Load latest version
            </Button>
          )}
        </div>
      )}
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {loading ? (
            <QuietStatus>Loading file…</QuietStatus>
          ) : mode === "image" ? (
            <ImagePreview file={selected} />
          ) : mode === "video" ? (
            <VideoPreview file={selected} />
          ) : mode === "pdf" || mode === "document" ? (
            <PdfPreview file={selected} onStale={() => void reopenSelected()} />
          ) : mode === "spreadsheet" ? (
            <SpreadsheetPreview
              key={selected.id}
              file={selected}
              disabled={disabled || readOnly}
              controlRef={sheetControl}
              onDirtyChange={setSheetDirty}
              onSaved={(saved) => {
                setSelected(saved);
                // Closing can unmount this panel before refresh finishes. Publish
                // the committed version immediately so reopening has the right CAS.
                onFiles(filesRef.current.map((file) => file.id === saved.id ? saved : file));
                void refresh(generation.current);
              }}
              onFailure={onFailure}
              onStale={() => void reopenSelected()}
            />
          ) : mode === "binary" ? (
            <BinaryCard file={selected} />
          ) : (
            <>
              {alternateView && view === "preview" ? (
                <div
                  role="region"
                  aria-label={`${alternateView} of ${selected.path}`}
                  tabIndex={0}
                  className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-none"
                >
                  {artifact ? (
                    <ArtifactFilePreview key={`${selected.id}:${selected.version}`} visual={truncated ? null : visual} canExport={allowExport} />
                  ) : alternateView === "Table" ? (
                    <TablePreview
                      text={text}
                      delimiter={selected.path.toLowerCase().endsWith(".tsv") ? "\t" : ","}
                    />
                  ) : (
                    <article className="mx-auto w-full max-w-[72ch] px-6 py-6 sm:px-8 [&_.cloud-markdown>h1:first-child]:mt-0 [&_.cloud-markdown_h2]:mt-8 [&_.cloud-markdown_h3]:mt-6">
                      <CloudMarkdown text={text} />
                    </article>
                  )}
                </div>
              ) : (
                <>
                  <label htmlFor="cloud-file-content" className="sr-only">
                    File content
                  </label>
                  <textarea
                    id="cloud-file-content"
                    value={text}
                    readOnly={
                      disabled || readOnly || truncated || uncertain || !!error
                    }
                    onChange={(event) => setText(event.target.value)}
                    spellCheck={false}
                    onBlur={(event) => {
                      // In-panel actions flush themselves; saving on their
                      // preceding blur would disable them before the click.
                      if (event.relatedTarget instanceof Node && panel.current?.contains(event.relatedTarget)) return;
                      void saveRef.current();
                    }}
                    className="min-h-0 flex-1 resize-none rounded-none border-0 bg-background px-6 py-6 font-mono text-sm leading-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden outline-none focus-visible:outline-none"
                  />
                </>
              )}
              {truncated && (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Preview shows the first 1,000 lines. Download the complete
                  file to edit it.
                </p>
              )}
            </>
          )}
          {(uncertain || (error && dirty)) && (
            <div className="border-t border-border px-4 py-3 text-xs leading-5">
              <p>Your edit is kept here. Download your draft before loading the latest version.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={downloadDraft}>Download draft</Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  if (window.confirm("Discard your unsaved file changes and load the latest version?")) void open(selected);
                }}>Load latest version</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileTextIcon aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Files created in this conversation will open here.</p>
        </div>
      )}
    </aside>
  );
}
export function formatSize(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
