"use client";

import type { CloudFile } from "@lori-enterprise/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileWarningIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { ClientApiError } from "@/lib/client-api";
import { cloudApi, cloudPath } from "@/lib/cloud-work-api";
import {
  PageLoader,
  type LoaderSnapshot,
  type PageSource,
  type PageView,
} from "./page-loader";

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;
const GUTTER = 12;
/** A US Letter page, until a real page has been measured. */
const FALLBACK_RATIO = 11 / 8.5;
/** Placeholders beyond this are not drawn; the rest of a huge document is a download away. */
const MAX_SLOTS = 1000;
const FALLBACK_WIDTH = 480;

const EMPTY: LoaderSnapshot = { total: null, pages: new Map(), fatal: null };
const noop = () => {};
const noSubscribe = () => noop;
const emptySnapshot = () => EMPTY;

/** Network access for one file version; every request is bound to its hash. */
function createSource(file: Pick<CloudFile, "id" | "sha256">, previewPath?: string): PageSource {
  const path = previewPath ?? `/files/${encodeURIComponent(file.id)}/preview`;
  const query = (page: number) => `page=${page}&hash=${encodeURIComponent(file.sha256)}`;
  const fetchImage = async (page: number, signal: AbortSignal) => {
    const response = await fetch(`/api${cloudPath}${path}/image?${query(page)}`, {
      credentials: "same-origin",
      signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
      throw new ClientApiError(
        typeof body.error === "string" ? body.error : "request_failed",
        typeof body.message === "string" ? body.message : "The page could not be loaded.",
        response.status,
      );
    }
    const blob = await response.blob();
    const total = Number(response.headers.get("x-total-pages"));
    return {
      blob: blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" }),
      totalPages: Number.isInteger(total) && total > 0 ? total : null,
    };
  };
  return {
    // The server holds this open until the page is ready, so the page appears the moment it is rendered.
    status: (page, retry, signal) =>
      cloudApi(`${path}?${query(page)}&wait=2500${retry ? "&retry=true" : ""}`, { signal }),
    image: async (page, signal) => (await fetchImage(page, signal))?.blob ?? null,
    peek: fetchImage,
  };
}

function useLoader(id: string, sha256: string, previewPath?: string) {
  const [loader, setLoader] = useState<PageLoader | null>(null);
  useEffect(() => {
    // Created here, not during render, so React's strict remount gets a fresh loader.
    const next = new PageLoader(createSource({ id, sha256 }, previewPath));
    setLoader(next);
    next.want([1]);
    return () => next.dispose();
  }, [id, sha256, previewPath]);
  const snapshot = useSyncExternalStore(
    loader ? loader.subscribe : noSubscribe,
    loader ? loader.getSnapshot : emptySnapshot,
    emptySnapshot,
  );
  return { loader, snapshot };
}

/** The available viewport, measured again when it resizes or is replaced (`mounted` changes). */
function useViewport(ref: RefObject<HTMLElement | null>, mounted: boolean) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mounted]);
  return size;
}

/** Private page rendering through the qualified worker, never an external viewer. */
/** `previewPath` names another source of the same page images, such as a personal project's reference file. */
export function DocumentPreview({ file, onStale, previewPath }: { file: CloudFile; onStale?: () => void; previewPath?: string }) {
  const presentation = /\.(pptx?|odp)$/i.test(file.path);
  const unit = presentation ? "Slide" : "Page";
  const { loader, snapshot } = useLoader(file.id, file.sha256, previewPath);
  const scroller = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, HTMLElement>());
  const anchor = useRef<number | null>(null);
  const [zoom, setZoom] = useState(100);
  const [current, setCurrent] = useState(1);
  const [draft, setDraft] = useState<string | null>(null);
  const fatal = snapshot.fatal;
  const viewport = useViewport(scroller, !fatal);

  const total = snapshot.total;
  const slotCount = Math.min(Math.max(total ?? 1, 1), MAX_SLOTS);
  // Presentation placeholders use a slide shape until the actual aspect ratio is known.
  let typical = presentation ? 9 / 16 : FALLBACK_RATIO;
  for (const view of snapshot.pages.values())
    if (view.ratio) {
      typical = view.ratio;
      break;
    }
  const ratio = snapshot.pages.get(current)?.ratio ?? typical;
  const availableWidth = Math.max(1, (viewport.width || FALLBACK_WIDTH) - GUTTER * 2);
  const availableHeight = Math.max(1, (viewport.height || 360) - GUTTER * 2);
  const fittedWidth = presentation ? Math.min(availableWidth, availableHeight / ratio) : availableWidth;
  const pageWidth = Math.max(presentation ? 1 : 120, Math.round(fittedWidth * zoom / 100));

  useEffect(() => {
    if (!presentation || !loader || fatal) return;
    loader.focus(current);
    loader.want([current, current - 1, current + 1].filter(page => page >= 1 && (!total || page <= total)));
  }, [presentation, loader, current, total, fatal]);

  // Pages near the viewport are loaded ahead of need, so scrolling rarely meets a blank page.
  useEffect(() => {
    const root = scroller.current;
    if (presentation || !loader || !root) return;
    if (typeof IntersectionObserver === "undefined") {
      loader.want(Array.from({ length: Math.min(slotCount, 4) }, (_, index) => index + 1));
      return;
    }
    const near = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) near.add(page);
          else near.delete(page);
        }
        loader.want(near);
      },
      { root, rootMargin: "120% 0px" },
    );
    for (const element of slots.current.values()) observer.observe(element);
    return () => observer.disconnect();
    // The viewer is replaced by an error card and back, so the observer follows `fatal` too.
  }, [loader, slotCount, fatal, presentation]);

  // The page being read is the one under a line a third of the way down the viewport. Computed from
  // positions (not intersection ratios, which only update at thresholds), once per frame while scrolling.
  useEffect(() => {
    const root = scroller.current;
    if (presentation || !loader || !root) return;
    let frame = 0;
    let pending = false;
    const update = () => {
      pending = false;
      const probe = root.scrollTop + root.clientHeight * 0.35;
      let low = 1;
      let high = slotCount;
      let page = 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const element = slots.current.get(middle);
        if (!element) break;
        if (element.offsetTop <= probe) {
          page = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      setCurrent(page);
      loader.focus(page);
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(update);
    };
    root.addEventListener("scroll", schedule, { passive: true });
    return () => {
      root.removeEventListener("scroll", schedule);
      if (pending) cancelAnimationFrame(frame);
    };
  }, [loader, slotCount, fatal, presentation]);

  // Zooming changes every page's height; keep the reader at the same place in the document.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (anchor.current === null || !element) return;
    element.scrollTop = anchor.current * element.scrollHeight;
    anchor.current = null;
  }, [zoom]);

  const zoomTo = (next: number) => {
    const element = scroller.current;
    anchor.current = element && element.scrollHeight ? element.scrollTop / element.scrollHeight : null;
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
  };

  const goTo = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(1, Math.round(page)), total ?? slotCount);
      const element = slots.current.get(target);
      const root = scroller.current;
      setCurrent(target);
      if (loader) {
        loader.focus(target);
        loader.want([target]);
      }
      if (presentation && root) {
        root.scrollTop = 0;
        root.scrollLeft = 0;
      } else if (element && root) {
        const top = Math.max(0, element.offsetTop - GUTTER);
        if (typeof root.scrollTo === "function") root.scrollTo({ top, behavior: "auto" });
        else root.scrollTop = top;
      }
    },
    [loader, total, slotCount, presentation],
  );

  const register = useCallback((page: number, element: HTMLElement | null) => {
    if (element) slots.current.set(page, element);
    else slots.current.delete(page);
  }, []);

  const commitDraft = () => {
    const page = Number(draft);
    setDraft(null);
    if (draft !== null && draft.trim() && Number.isFinite(page)) goTo(page);
  };

  // "Preparing" lasts until the document has opened (its length is known), not whenever page 1's image is released.
  const preparing = !fatal && total === null;
  const status = preparing
    ? `Preparing ${unit.toLowerCase()} 1…`
    : `${unit} ${current}${total ? ` of ${total}` : ""}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {fatal ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarningIcon aria-hidden className="size-7 text-muted-foreground" />
          <p role="alert" className="max-w-[40ch] text-sm leading-6 text-muted-foreground">
            {fatal.message}
          </p>
          {fatal.kind === "stale" && onStale ? (
            <Button size="sm" variant="ghost" onClick={onStale}>
              <RotateCwIcon aria-hidden />
              Load latest version
            </Button>
          ) : fatal.kind !== "unsupported" && fatal.kind !== "session" ? (
            <Button size="sm" variant="ghost" onClick={() => loader?.retryAll()}>
              <RotateCwIcon aria-hidden />
              Retry preview
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          ref={scroller}
          role="region"
          aria-label={`${presentation ? "Presentation" : "Document"} preview: ${file.path}`}
          aria-busy={preparing || (presentation && snapshot.pages.get(current)?.status === "loading")}
          onKeyDown={event => {
            if (!presentation || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.key === "ArrowRight" || event.key === "PageDown" ? current + 1
              : event.key === "ArrowLeft" || event.key === "PageUp" ? current - 1
              : event.key === "Home" ? 1 : event.key === "End" ? total : null;
            if (target !== null) { event.preventDefault(); event.stopPropagation(); goTo(target); }
          }}
          tabIndex={0}
          className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div
            className={`flex min-w-full w-max flex-col items-center gap-3 ${presentation ? "min-h-full justify-center" : ""}`}
            style={{ padding: GUTTER }}
          >
            {(presentation ? [current] : Array.from({ length: slotCount }, (_, index) => index + 1)).map((page) => (
              <PageSlot
                key={page}
                page={page}
                presentation={presentation}
                total={total}
                title={file.path}
                width={pageWidth}
                view={snapshot.pages.get(page)}
                typical={typical}
                loader={loader}
                register={register}
              />
            ))}
            {!presentation && total !== null && total > MAX_SLOTS && (
              <p className="py-2 text-xs text-muted-foreground">
                Showing the first {MAX_SLOTS} pages. Download the file for the rest.
              </p>
            )}
          </div>
        </div>
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border/60 px-2 py-1">
        <div role="group" aria-label={presentation ? "Presentation slides" : "Document pages"} className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Previous ${unit.toLowerCase()}`}
            disabled={!!fatal || current <= 1}
            onClick={() => goTo(current - 1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <label className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
            <span className={presentation ? "text-muted-foreground" : "sr-only"}>{unit}<span className="sr-only"> number</span></span>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              disabled={!!fatal}
              value={draft ?? String(current)}
              onFocus={(event) => {
                setDraft(String(current));
                event.currentTarget.select();
              }}
              onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 5))}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setDraft(null);
                  event.currentTarget.blur();
                }
              }}
              className="h-7 w-11 rounded bg-secondary/60 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
            <span aria-hidden>/ {total ?? "…"}</span>
          </label>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Next ${unit.toLowerCase()}`}
            disabled={!!fatal || !total || current >= total}
            onClick={() => goTo(current + 1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
        <div role="group" aria-label="Document zoom" className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Zoom out"
            disabled={!!fatal || zoom <= ZOOM_MIN}
            onClick={() => zoomTo(zoom - ZOOM_STEP)}
          >
            <MinusIcon aria-hidden />
          </Button>
          <button
            type="button"
            disabled={!!fatal}
            className="h-8 min-w-11 rounded text-xs tabular-nums text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            title={presentation ? "Fit slide" : "Fit to width"}
            aria-label={presentation ? "Fit slide" : "Fit document to width"}
            aria-pressed={zoom === 100}
            onClick={() => zoomTo(100)}
          >
            {presentation && zoom === 100 ? "Fit" : `${zoom}%`}
          </button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Zoom in"
            disabled={!!fatal || zoom >= ZOOM_MAX}
            onClick={() => zoomTo(zoom + ZOOM_STEP)}
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Memoized: a long document updates one page at a time, not all of them. */
const PageSlot = memo(function PageSlot({
  page,
  total,
  title,
  width,
  view,
  typical,
  loader,
  register,
  presentation = false,
}: {
  page: number;
  presentation?: boolean;
  total: number | null;
  title: string;
  width: number;
  view: PageView | undefined;
  typical: number;
  loader: PageLoader | null;
  register: (page: number, element: HTMLElement | null) => void;
}) {
  const unit = presentation ? "Slide" : "Page";
  const [broken, setBroken] = useState(false);
  const url = view?.url ?? null;
  useEffect(() => setBroken(false), [url]);
  const attach = useCallback((element: HTMLElement | null) => register(page, element), [register, page]);
  const onMeasure = (ratio: number) => loader?.measure(page, ratio);
  const onRetry = () => loader?.retry(page);
  const failed = view?.status === "failed" || broken;
  const height = Math.round(width * (view?.ratio ?? typical));
  return (
    <div
      ref={attach}
      data-page={page}
      role="group"
      aria-label={`${unit} ${page}${total ? ` of ${total}` : ""}`}
      className={`relative shrink-0 overflow-hidden bg-white shadow-sm ${presentation ? "" : "rounded-sm ring-1 ring-black/10 dark:ring-white/10"}`}
      style={{ width, height }}
    >
      {url && !broken ? (
        // A private object URL for the member's own page, so next/image has nothing to optimize.
        <img
          src={url}
          alt={`${title}, ${unit.toLowerCase()} ${page}${total ? ` of ${total}` : ""}`}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0) onMeasure(naturalHeight / naturalWidth);
          }}
          onError={() => setBroken(true)}
          className="block size-full select-none object-contain"
        />
      ) : failed ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 bg-secondary/70 px-4 text-center">
          <p className="max-w-[30ch] text-xs leading-5 text-muted-foreground">
            {broken ? `This ${unit.toLowerCase()} could not be shown.` : view?.message || `This ${unit.toLowerCase()} could not be rendered.`}
          </p>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <RotateCwIcon aria-hidden />
            Retry {unit.toLowerCase()} {page}
          </Button>
        </div>
      ) : (
        // A blank sheet of paper in the page's own shape: the page appears in place, with no spinner.
        // Only a page that is genuinely slow says anything.
        <div aria-hidden className="flex size-full items-end justify-center pb-3">
          {(presentation || view?.slow) && <span className="px-4 text-center text-xs text-neutral-600">{view?.slow ? `Still preparing this ${unit.toLowerCase()}…` : `Loading slide ${page}…`}</span>}
        </div>
      )}
    </div>
  );
});
