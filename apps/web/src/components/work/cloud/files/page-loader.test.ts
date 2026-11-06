import { describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/client-api";
import {
  PageLoader,
  POLL_DELAYS_MS,
  pollDelay,
  type LoaderOptions,
  type PageSource,
  type PageStatus,
} from "./page-loader";

type Step = PageStatus | ClientApiError | "image-missing";
const ready = (totalPages = 10): PageStatus => ({ status: "ready", totalPages });
const queued = (totalPages: number | null = null): PageStatus => ({ status: "queued", totalPages });
const failed = (totalPages: number | null = null): PageStatus => ({ status: "failed", totalPages });
const error = (code: string, status: number) => new ClientApiError(code, code, status);
const png = () => new Blob(["png"], { type: "image/png" });

/** A scripted server: each page's answers are consumed in order and the last one repeats. */
function setup(script: Record<number, Step[]> | ((page: number) => Step[]), extra: LoaderOptions = {}) {
  let clock = 0;
  const steps = new Map<number, Step[]>();
  const calls: { page: number; retry: boolean }[] = [];
  const delays: number[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  const missing = new Set<number>();
  const source: PageSource = {
    status: vi.fn(async (page: number, retry: boolean) => {
      calls.push({ page, retry });
      const list = steps.get(page) ?? [...(typeof script === "function" ? script(page) : (script[page] ?? [ready()]))];
      steps.set(page, list);
      const step = list.length > 1 ? list.shift()! : list[0]!;
      if (step === "image-missing") {
        missing.add(page);
        return ready();
      }
      if (step instanceof Error) throw step;
      return step;
    }),
    image: vi.fn(async (page: number) => (missing.delete(page) ? null : png())),
  };
  const loader = new PageLoader(source, {
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    now: () => clock,
    makeUrl: () => {
      const url = `blob:${urls.length}`;
      urls.push(url);
      return url;
    },
    revokeUrl: (url) => void revoked.push(url),
    ...extra,
  });
  const view = (page: number) => loader.getSnapshot().pages.get(page);
  const settle = (check: () => void) => vi.waitFor(check, { timeout: 2000 });
  return { loader, source, calls, delays, urls, revoked, view, settle, advance: (ms: number) => void (clock += ms) };
}

describe("PageLoader", () => {
  it("loads the first page for its length, then the pages being read, nearest first", async () => {
    const t = setup({}, { concurrency: 1 });
    t.loader.focus(3);
    t.loader.want([1, 2, 3, 4, 5]);
    await t.settle(() => expect(t.view(5)?.status).toBe("ready"));
    expect(t.calls.map((c) => c.page)).toEqual([1, 3, 2, 4, 5]);
    expect(t.loader.getSnapshot().total).toBe(10);
  });

  it("never runs more pages at once than its limit", async () => {
    let active = 0;
    let most = 0;
    const t = setup({});
    vi.mocked(t.source.status).mockImplementation(async (page) => {
      active++;
      most = Math.max(most, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
      t.calls.push({ page, retry: false });
      return ready();
    });
    t.loader.want([1, 2, 3, 4, 5, 6]);
    await t.settle(() => expect(t.view(6)?.status).toBe("ready"));
    expect(most).toBe(2);
  });

  it("ignores pages past the end once the length is known", async () => {
    const t = setup({}, { concurrency: 1 });
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    t.loader.want([9, 10, 11, 12]);
    await t.settle(() => expect(t.view(10)?.status).toBe("ready"));
    expect(t.calls.map((c) => c.page)).not.toContain(11);
  });

  it("waits with growing pauses while a page renders, then shows it", async () => {
    const t = setup({ 1: [queued(), queued(), { status: "running", totalPages: 5 }, ready(5)] });
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    expect(t.delays).toEqual(POLL_DELAYS_MS.slice(0, 3));
    expect(t.view(1)?.url).toBe("blob:0");
    expect(t.loader.getSnapshot().total).toBe(5);
  });

  describe("a source that can hand over a finished page in one request", () => {
    const withPeek = (peek: NonNullable<PageSource["peek"]>) => {
      const t = setup({});
      t.source.peek = vi.fn(peek);
      return t;
    };
    it("shows a rendered page and learns the document's length without asking for a status", async () => {
      const t = withPeek(async () => ({ blob: png(), totalPages: 7 }));
      t.loader.want([1]);
      await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
      expect(t.loader.getSnapshot().total).toBe(7);
      expect(t.source.status).not.toHaveBeenCalled();
      expect(t.source.image).not.toHaveBeenCalled();
      expect(t.source.peek).toHaveBeenCalledTimes(1);
    });
    it("falls back to asking for a status when the page is not rendered yet", async () => {
      const t = withPeek(async () => null);
      t.loader.want([1]);
      await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
      expect(t.calls).toEqual([{ page: 1, retry: false }]);
      expect(t.loader.getSnapshot().total).toBe(10);
    });
    it("goes straight to the status when a failed page is retried, so it is rendered again", async () => {
      const t = withPeek(async () => null);
      t.loader.want([1]);
      await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
      vi.mocked(t.source.peek!).mockClear();
      vi.mocked(t.source.peek!).mockResolvedValue({ blob: png(), totalPages: 10 });
      t.loader.retry(1);
      await t.settle(() => expect(t.calls).toHaveLength(2));
      expect(t.calls[1]).toEqual({ page: 1, retry: true });
      expect(t.source.peek).not.toHaveBeenCalled();
    });
    it("treats a problem with the file as it would from a status request", async () => {
      const t = withPeek(async () => {
        throw error("cloud_file_conflict", 409);
      });
      t.loader.want([1]);
      await t.settle(() => expect(t.loader.getSnapshot().fatal?.kind).toBe("stale"));
    });
    it("does not show a page whose request was cancelled", async () => {
      let release!: () => void;
      const t = withPeek(() => new Promise((resolve) => (release = () => resolve({ blob: png(), totalPages: 3 }))));
      t.loader.want([1]);
      await t.settle(() => expect(release).toBeTypeOf("function"));
      t.loader.dispose();
      release();
      await Promise.resolve();
      expect(t.urls).toEqual([]);
    });
  });

  it("caps the pause between checks", () => {
    expect(pollDelay(0)).toBe(POLL_DELAYS_MS[0]);
    expect(pollDelay(99)).toBe(POLL_DELAYS_MS.at(-1));
  });

  it("tells the person when a page is slow, and gives up after the deadline", async () => {
    const t = setup({ 1: [ready(3)], 2: [queued(3)] }, { slowAfterMs: 1000, deadlineMs: 4000 });
    t.loader.want([1, 2]);
    await t.settle(() => expect(t.view(2)?.status).toBe("failed"));
    expect(t.view(2)?.message).toMatch(/longer than expected/);
    expect(t.delays.length).toBeGreaterThan(2);
  });

  it("marks a page slow while it is still rendering", async () => {
    // The wait never ends, so the slow state can be observed before any give-up.
    const t = setup({ 1: [ready(3)], 2: [queued(3)] }, { slowAfterMs: 0, sleep: () => new Promise<void>(() => {}) });
    t.loader.want([1, 2]);
    await t.settle(() => expect(t.view(2)?.slow).toBe(true));
    expect(t.view(2)?.status).toBe("loading");
  });

  it("asks again when the server dropped a finished page, and stops after two tries", async () => {
    const t = setup({ 1: ["image-missing", ready()] });
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    expect(t.calls.map((c) => c.page)).toEqual([1, 1]);

    const gone = setup({});
    vi.mocked(gone.source.image).mockResolvedValue(null);
    gone.loader.want([1]);
    await gone.settle(() => expect(gone.view(1)?.status).toBe("failed"));
    expect(gone.calls).toHaveLength(3);
  });

  it("releases pages far from the one being read and reloads them when wanted again", async () => {
    const t = setup({}, { keepBehind: 1, keepAhead: 1 });
    t.loader.want([1, 2, 3, 4]);
    await t.settle(() => expect(t.view(4)?.status).toBe("ready"));
    // The reader scrolled down: only page 4 is on screen now.
    t.loader.want([4]);
    t.loader.focus(4);
    expect(t.view(1)).toMatchObject({ status: "idle", url: null });
    expect(t.view(2)).toMatchObject({ status: "idle", url: null });
    expect(t.view(3)?.status).toBe("ready");
    expect(t.revoked).toHaveLength(2);
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
  });

  it("does not release a page the reader just asked for", async () => {
    const t = setup({ 1: [ready(100)], 50: [ready(100)], 51: [ready(100)] }, { keepBehind: 1, keepAhead: 1 });
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    t.loader.focus(50);
    t.loader.want([50, 51]);
    await t.settle(() => expect(t.view(50)?.status).toBe("ready"));
    expect(t.view(50)?.url).not.toBeNull();
  });

  it("keeps a page's measured shape when its image is released", async () => {
    const t = setup({}, { keepBehind: 0, keepAhead: 0 });
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    t.loader.measure(1, 1.4);
    t.loader.want([]);
    t.loader.focus(9);
    expect(t.view(1)).toMatchObject({ status: "idle", ratio: 1.4 });
    t.loader.measure(1, Number.NaN);
    t.loader.measure(1, -2);
    expect(t.view(1)?.ratio).toBe(1.4);
  });

  describe("when rendering fails", () => {
    it("treats a failed first page as a failed document, and a retry asks for a fresh render", async () => {
      const t = setup({ 1: [failed(), ready(2)] });
      t.loader.want([1]);
      await t.settle(() => expect(t.loader.getSnapshot().fatal?.kind).toBe("failed"));
      expect(t.loader.getSnapshot().fatal?.message).toMatch(/password-protected or damaged/);
      t.loader.retryAll();
      await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
      expect(t.loader.getSnapshot().fatal).toBeNull();
      expect(t.calls.at(-1)).toEqual({ page: 1, retry: true });
    });

    it("fails only the one page once the length is known, and retries just that page", async () => {
      const t = setup({ 1: [ready(4)], 3: [failed(4), ready(4)] });
      t.loader.want([1, 2, 3]);
      await t.settle(() => expect(t.view(3)?.status).toBe("failed"));
      expect(t.view(2)?.status).toBe("ready");
      expect(t.loader.getSnapshot().fatal).toBeNull();
      t.loader.retry(3);
      await t.settle(() => expect(t.view(3)?.status).toBe("ready"));
      expect(t.calls.filter((c) => c.page === 3)).toEqual([
        { page: 3, retry: false },
        { page: 3, retry: true },
      ]);
    });

    it.each([
      ["cloud_file_conflict", 409, "stale"],
      ["cloud_preview_unavailable", 503, "unavailable"],
      ["cloud_preview_unsupported", 415, "unsupported"],
      ["unauthorized", 401, "session"],
    ])("reports %s as a problem with the whole document", async (code, status, kind) => {
      const t = setup({ 1: [error(code, status)] });
      t.loader.want([1, 2]);
      await t.settle(() => expect(t.loader.getSnapshot().fatal?.kind).toBe(kind));
      const calls = t.calls.length;
      t.loader.want([1, 2, 3]);
      expect(t.calls).toHaveLength(calls);
    });

    it("quietly tries a busy or briefly offline page again", async () => {
      const t = setup({ 1: [error("cloud_preview_busy", 429), error("network_unavailable", 0), ready(2)] });
      t.loader.want([1]);
      await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
      expect(t.delays.filter((ms) => ms === 2500)).toHaveLength(2);
      expect(t.loader.getSnapshot().fatal).toBeNull();
    });

    it("fails a page that cannot be reached for good", async () => {
      const t = setup({ 1: [ready(3)], 2: [error("internal_error", 500)] });
      t.loader.want([1, 2]);
      await t.settle(() => expect(t.view(2)?.status).toBe("failed"));
      expect(t.view(2)?.message).toMatch(/could not be rendered/);
    });
  });

  it("stops everything and frees every image when disposed", async () => {
    const t = setup({ 1: [ready(3)], 2: [queued(3)] });
    t.loader.want([1, 2]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    const listener = vi.fn();
    t.loader.subscribe(listener);
    t.loader.dispose();
    expect(t.revoked).toEqual(["blob:0"]);
    t.loader.want([3, 4]);
    t.loader.retry(1);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(t.calls.map((c) => c.page)).not.toContain(3);
  });

  it("gives subscribers a new snapshot only when something changed", async () => {
    const t = setup({});
    const first = t.loader.getSnapshot();
    expect(t.loader.getSnapshot()).toBe(first);
    t.loader.want([1]);
    await t.settle(() => expect(t.view(1)?.status).toBe("ready"));
    expect(t.loader.getSnapshot()).not.toBe(first);
  });
});
