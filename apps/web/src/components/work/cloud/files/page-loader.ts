import { ClientApiError } from "@/lib/client-api";

export type RenderStatus = "queued" | "running" | "ready" | "failed";

export interface PageStatus {
  status: RenderStatus;
  totalPages: number | null;
}

/** What the loader needs from the network, so it can be exercised without one. */
export interface PageSource {
  status(page: number, retry: boolean, signal: AbortSignal): Promise<PageStatus>;
  /** The rendered page, or null when the server no longer has it (the loader asks again). */
  image(page: number, signal: AbortSignal): Promise<Blob | null>;
  /**
   * Tries to fetch a finished page in one request, along with the document's length, before any
   * status is asked for. Null when the page is not rendered yet. A source without it always asks first.
   */
  peek?(page: number, signal: AbortSignal): Promise<{ blob: Blob; totalPages: number | null } | null>;
}

export interface PageView {
  status: "idle" | "loading" | "ready" | "failed";
  url: string | null;
  /** Height divided by width, known once the image has been measured. */
  ratio: number | null;
  /** True once a page has waited long enough that the person should be told why. */
  slow: boolean;
  message: string;
}

/** A problem with the document as a whole rather than one page. */
export interface Fatal {
  kind: "stale" | "unavailable" | "unsupported" | "session" | "failed";
  message: string;
}

export interface LoaderSnapshot {
  total: number | null;
  pages: ReadonlyMap<number, PageView>;
  fatal: Fatal | null;
}

export interface LoaderOptions {
  concurrency?: number;
  /** How long one page may stay queued or rendering before it is reported as slow. */
  slowAfterMs?: number;
  /** How long to wait for one page before giving up. */
  deadlineMs?: number;
  /** Pages kept in memory on each side of the one being read. */
  keepBehind?: number;
  keepAhead?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  makeUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/**
 * Waits between status checks. The server holds each check open until the page is ready, so these
 * only space out the rare repeats (and cover an older server that answers at once).
 */
export const POLL_DELAYS_MS = [120, 200, 320, 500, 800, 1200, 1800, 2400] as const;
export const pollDelay = (attempt: number) =>
  POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]!;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const TRANSIENT = new Set([
  "cloud_preview_busy",
  "rate_limited",
  "request_timeout",
  "network_unavailable",
]);

const blank = (): PageView => ({ status: "idle", url: null, ratio: null, slow: false, message: "" });

/**
 * Loads rendered document pages on demand. A few pages load at once, nearest
 * the one being read first; pages far from it are released so a long document
 * never holds every image in memory. Nothing here knows about React.
 */
export class PageLoader {
  private readonly concurrency: number;
  private readonly slowAfter: number;
  private readonly deadline: number;
  private readonly behind: number;
  private readonly ahead: number;
  private readonly sleep: NonNullable<LoaderOptions["sleep"]>;
  private readonly now: () => number;
  private readonly makeUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly controllers = new Map<number, AbortController>();
  private readonly retried = new Set<number>();
  private readonly pages = new Map<number, PageView>();
  private wanted = new Set<number>();
  private focused = 1;
  private total: number | null = null;
  private fatal: Fatal | null = null;
  private closed = false;
  private snapshot: LoaderSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly source: PageSource, options: LoaderOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.slowAfter = options.slowAfterMs ?? 8_000;
    this.deadline = options.deadlineMs ?? 130_000;
    this.behind = options.keepBehind ?? 6;
    this.ahead = options.keepAhead ?? 12;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.makeUrl = options.makeUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  /** Pages the reader can currently see or is about to; everything else waits. */
  want(pages: Iterable<number>) {
    if (this.closed || this.fatal) return;
    this.wanted = new Set(pages);
    this.pump();
  }

  /** The page being read: it loads first and decides which pages stay in memory. */
  focus(page: number) {
    if (this.closed) return;
    this.focused = page;
    if (this.release()) this.publish();
    this.pump();
  }

  /** Records a page's true proportions so its slot stops resizing. */
  measure(page: number, ratio: number) {
    const view = this.pages.get(page);
    if (!view || !Number.isFinite(ratio) || ratio <= 0 || view.ratio === ratio) return;
    this.pages.set(page, { ...view, ratio });
    this.publish();
  }

  /** Starts a failed page over, asking the server to render it again. */
  retry(page: number) {
    if (this.closed) return;
    if (this.fatal) this.fatal = null;
    this.pages.set(page, { ...(this.pages.get(page) ?? blank()), status: "idle", message: "", slow: false });
    this.retried.add(page);
    this.publish();
    this.pump();
  }

  retryAll() {
    this.fatal = null;
    for (const [page, view] of this.pages)
      if (view.status === "failed") {
        this.pages.set(page, { ...view, status: "idle", message: "", slow: false });
        this.retried.add(page);
      }
    if (!this.pages.has(1)) this.pages.set(1, blank());
    this.retried.add(1);
    this.publish();
    this.pump();
  }

  dispose() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const view of this.pages.values()) if (view.url) this.revokeUrl(view.url);
    this.pages.clear();
    this.listeners.clear();
  }

  private pump() {
    if (this.closed || this.fatal) return;
    // The first page also tells us how long the document is, so it is never left waiting.
    if (this.total === null) this.wanted.add(1);
    const unknown = this.total === null;
    const queue = [...this.wanted]
      .filter((page) => (this.total === null || page <= this.total) && (this.pages.get(page)?.status ?? "idle") === "idle" && !this.controllers.has(page))
      .sort((a, b) =>
        unknown && (a === 1 || b === 1)
          ? Number(b === 1) - Number(a === 1)
          : Math.abs(a - this.focused) - Math.abs(b - this.focused) || a - b,
      );
    for (const page of queue) {
      if (this.controllers.size >= this.concurrency) break;
      void this.load(page);
    }
  }

  private async load(page: number) {
    const controller = new AbortController();
    this.controllers.set(page, controller);
    const view = this.pages.get(page) ?? blank();
    this.pages.set(page, { ...view, status: "loading", message: "", slow: false });
    this.publish();
    const started = this.now();
    try {
      let attempt = 0;
      // A page that is already rendered (usually the case) arrives in one request, with the document's length.
      if (this.source.peek && !this.retried.has(page)) {
        const found = await this.source.peek(page, controller.signal);
        if (this.closed || controller.signal.aborted) return;
        if (found) {
          if (found.totalPages !== null && found.totalPages !== this.total) this.total = found.totalPages;
          return this.ready(page, found.blob);
        }
      }
      for (let images = 0; ; ) {
        const retry = this.retried.delete(page);
        const result = await this.source.status(page, retry, controller.signal);
        if (this.closed || controller.signal.aborted) return;
        if (result.totalPages !== null && result.totalPages !== this.total) this.total = result.totalPages;
        if (result.status === "failed")
          return this.fail(page, page === 1 && this.total === null ? "document" : "page");
        if (result.status === "ready") {
          const blob = await this.source.image(page, controller.signal);
          if (this.closed || controller.signal.aborted) return;
          if (blob) return this.ready(page, blob);
          // The server dropped the page between the two requests; asking again renders it again.
          if (++images > 2) return this.fail(page, "page");
          continue;
        }
        const waited = this.now() - started;
        if (waited >= this.deadline)
          return this.fail(page, "slow");
        if (waited >= this.slowAfter) this.markSlow(page);
        await this.sleep(pollDelay(attempt++), controller.signal);
        if (this.closed || controller.signal.aborted) return;
      }
    } catch (failure) {
      if (this.closed || controller.signal.aborted) return;
      this.handle(page, failure, started);
    } finally {
      if (this.controllers.get(page) === controller) this.controllers.delete(page);
      // A freed slot may let the next page start.
      if (!this.closed) queueMicrotask(() => this.pump());
    }
  }

  private markSlow(page: number) {
    const view = this.pages.get(page);
    if (!view || view.slow) return;
    this.pages.set(page, { ...view, slow: true });
    this.publish();
  }

  private ready(page: number, blob: Blob) {
    const previous = this.pages.get(page) ?? blank();
    if (previous.url) this.revokeUrl(previous.url);
    this.pages.set(page, { ...previous, status: "ready", url: this.makeUrl(blob), slow: false, message: "" });
    this.release();
    this.publish();
  }

  private fail(page: number, why: "document" | "page" | "slow") {
    if (why === "document") {
      this.fatal = {
        kind: "failed",
        message:
          "This document could not be rendered. It may be password-protected or damaged. You can still download the original.",
      };
      this.pages.set(page, { ...(this.pages.get(page) ?? blank()), status: "failed", message: "" });
    } else
      this.pages.set(page, {
        ...(this.pages.get(page) ?? blank()),
        status: "failed",
        slow: false,
        message:
          why === "slow"
            ? "This page is taking longer than expected."
            : "This page could not be rendered.",
      });
    this.publish();
  }

  private handle(page: number, failure: unknown, started: number) {
    const code = failure instanceof ClientApiError ? failure.code : "";
    const status = failure instanceof ClientApiError ? failure.status : 0;
    if (status === 401) return this.stop({ kind: "session", message: "Your session ended. Sign in again to keep reading." });
    if (code === "cloud_file_conflict")
      return this.stop({ kind: "stale", message: "This file was updated since you opened it." });
    if (code === "cloud_preview_unavailable")
      return this.stop({
        kind: "unavailable",
        message: "Document previews are temporarily unavailable. You can still download the file.",
      });
    if (code === "cloud_preview_unsupported")
      return this.stop({ kind: "unsupported", message: "This format does not have a document preview." });
    if (code === "cloud_preview_page_missing") {
      this.pages.set(page, { ...(this.pages.get(page) ?? blank()), status: "failed", message: "This page is not in the document." });
      return this.publish();
    }
    if (TRANSIENT.has(code) && this.now() - started < this.deadline) {
      // Busy or briefly offline: stay quiet and try the same page again shortly.
      this.pages.set(page, { ...(this.pages.get(page) ?? blank()), status: "idle", slow: true });
      this.publish();
      const controller = new AbortController();
      this.controllers.set(page, controller);
      void this.sleep(2500, controller.signal).then(() => {
        if (this.controllers.get(page) === controller) this.controllers.delete(page);
        if (!this.closed && !controller.signal.aborted) this.pump();
      });
      return;
    }
    this.fail(page, "page");
  }

  private stop(fatal: Fatal) {
    this.fatal = fatal;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const [page, view] of this.pages)
      if (view.status === "loading") this.pages.set(page, { ...view, status: "idle" });
    this.publish();
  }

  /** Frees the images of pages well away from the one being read; true when any were freed. */
  private release() {
    const from = this.focused - this.behind;
    const to = this.focused + this.ahead;
    let freed = false;
    for (const [page, view] of this.pages)
      if (view.url && (page < from || page > to) && !this.wanted.has(page)) {
        this.revokeUrl(view.url);
        this.pages.set(page, { ...view, url: null, status: "idle" });
        freed = true;
      }
    return freed;
  }

  private build(): LoaderSnapshot {
    return { total: this.total, pages: new Map(this.pages), fatal: this.fatal };
  }
  private publish() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}
