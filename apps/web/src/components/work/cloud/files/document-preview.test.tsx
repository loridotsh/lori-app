import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CloudFile } from "@lori-enterprise/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/client-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { DocumentPreview } from "./document-preview";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<object>()), cloudApi: vi.fn() }));

const file = { id: "file-id", path: "report.pdf", sha256: "a".repeat(64) } as CloudFile;
const png = () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 });
const pageOf = (path: unknown) => Number(/page=(\d+)/.exec(String(path))?.[1]);
const statusOnly = (total: number) =>
  vi.mocked(cloudApi).mockImplementation(async (path) => ({ status: "ready", page: pageOf(path), totalPages: total }));

let created = 0;
let revoked: string[] = [];
beforeEach(() => {
  created = 0;
  revoked = [];
  // A page is not rendered the first time it is asked for (the opening request finds nothing), so the
  // status flow runs; every later request for it finds the picture.
  const asked = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const key = String(url);
    if (!asked.has(key)) {
      asked.add(key);
      return new Response(null, { status: 404 });
    }
    return png();
  }));
  // The default environment's observer never reports anything; without one the viewer loads the opening pages.
  vi.stubGlobal("IntersectionObserver", undefined);
  URL.createObjectURL = vi.fn(() => `blob:page-${created++}`);
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  statusOnly(3);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const images = () => screen.findAllByRole("img", { hidden: true });
const page = (n: number) => screen.getByRole("group", { name: new RegExp(`^Page ${n}\\b`) });
const field = () => screen.getByRole("textbox", { name: "Page number" }) as HTMLInputElement;

describe("Private document previews", () => {
  it("shows every page in one scrollable column, never an embedded viewer", async () => {
    render(<DocumentPreview file={file} />);
    const shown = await images();
    await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(3));
    expect(shown[0]!.getAttribute("alt")).toBe("report.pdf, page 1 of 3");
    expect(screen.getByRole("region", { name: "Document preview: report.pdf" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Page 1 of 3");
    expect(document.querySelector("iframe,object,embed")).toBeNull();
  });

  it("opens a document that is already rendered with one request per page and no status calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200, headers: { "x-total-pages": "3" } })));
    render(<DocumentPreview file={file} />);
    await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(3));
    expect(vi.mocked(cloudApi)).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Page 1 of 3");
  });

  it("shows a quiet blank page, never a spinner, while a page is being prepared", async () => {
    vi.useFakeTimers();
    vi.mocked(cloudApi).mockResolvedValue({ status: "running", page: 1, totalPages: 2 });
    const { container } = render(<DocumentPreview file={file} />);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector(".animate-spin, .animate-pulse, svg.lucide-loader-circle")).toBeNull();
    expect(screen.queryByText(/Still preparing/)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(screen.getByText("Still preparing this page…")).toBeTruthy();
  });

  it("binds every request to this file version and keeps the page private", async () => {
    render(<DocumentPreview file={file} />);
    await images();
    // The status request is held open by the server until the page is ready.
    expect(vi.mocked(cloudApi).mock.calls[0]![0]).toBe(`/files/file-id/preview?page=1&hash=${file.sha256}&wait=2500`);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`/api/v1/work/cloud/files/file-id/preview/image?page=1&hash=${file.sha256}`);
    expect(init).toMatchObject({ credentials: "same-origin" });
  });

  it("moves between pages from the buttons and the page field", async () => {
    render(<DocumentPreview file={file} />);
    await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(3));
    const previous = screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(field().value).toBe("2");
    expect(screen.getByRole("status").textContent).toBe("Page 2 of 3");
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "3" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("3");
    expect(next.disabled).toBe(true);
    expect(previous.disabled).toBe(false);
    // A page past the end goes to the last page; text that is not a page is ignored.
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "99" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("3");
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "abc" } });
    fireEvent.blur(field());
    expect(field().value).toBe("3");
  });

  it("zooms within bounds and returns to fit-width", async () => {
    render(<DocumentPreview file={file} />);
    await images();
    const width = () => Number.parseInt((page(1) as HTMLElement).style.width, 10);
    const fit = width();
    const fitButton = screen.getByRole("button", { name: "Fit document to width" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fitButton.textContent).toBe("125%");
    expect(width()).toBeGreaterThan(fit);
    fireEvent.click(fitButton);
    expect(fitButton.textContent).toBe("100%");
    expect(width()).toBe(fit);
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(fitButton.textContent).toBe("50%");
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fitButton.textContent).toBe("300%");
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a page that is still rendering, then shows it", async () => {
    vi.useFakeTimers();
    vi.mocked(cloudApi)
      .mockResolvedValueOnce({ status: "queued", page: 1, totalPages: null })
      .mockResolvedValue({ status: "ready", page: 1, totalPages: 1 });
    render(<DocumentPreview file={file} />);
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Preparing page 1…");
    expect(screen.getByRole("region", { name: /Document preview/ }).getAttribute("aria-busy")).toBe("true");
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByRole("status").textContent).toBe("Page 1 of 1");
    expect(vi.mocked(cloudApi)).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(vi.mocked(cloudApi)).toHaveBeenCalledTimes(2);
  });

  it("stops polling and frees every page image when closed", async () => {
    vi.useFakeTimers();
    vi.mocked(cloudApi).mockImplementation(async (path) =>
      pageOf(path) === 1
        ? { status: "ready", page: 1, totalPages: 3 }
        : { status: "queued", page: pageOf(path), totalPages: 3 },
    );
    const view = render(<DocumentPreview file={file} />);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    // Pages 2 and 3 are still rendering; their requests must not outlive the viewer.
    const waiting = vi.mocked(cloudApi).mock.calls.filter(([path]) => pageOf(path) > 1).map((call) => call[1]!.signal!);
    expect(waiting.length).toBeGreaterThan(0);
    view.unmount();
    expect(waiting.every((signal) => signal.aborted)).toBe(true);
    expect(revoked).toContain("blob:page-0");
    const calls = vi.mocked(cloudApi).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(vi.mocked(cloudApi)).toHaveBeenCalledTimes(calls);
  });

  describe("when something goes wrong", () => {
    it("explains a document that cannot be rendered and retries on request", async () => {
      vi.mocked(cloudApi).mockResolvedValueOnce({ status: "failed", page: 1, totalPages: null });
      render(<DocumentPreview file={file} />);
      expect((await screen.findByRole("alert")).textContent).toMatch(/password-protected or damaged/);
      fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
      await waitFor(() =>
        expect(vi.mocked(cloudApi).mock.calls.some(([path]) => pageOf(path) === 1 && String(path).endsWith("&retry=true"))).toBe(true),
      );
      await images();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("fails only the page that failed, and retries just that page", async () => {
      vi.mocked(cloudApi).mockImplementation(async (path) =>
        pageOf(path) === 2 && !String(path).includes("retry")
          ? { status: "failed", page: 2, totalPages: 3 }
          : { status: "ready", page: pageOf(path), totalPages: 3 },
      );
      render(<DocumentPreview file={file} />);
      const retry = await screen.findByRole("button", { name: "Retry page 2" });
      expect(within(page(2)).getByText("This page could not be rendered.")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(2));
      fireEvent.click(retry);
      await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(3));
      expect(vi.mocked(cloudApi).mock.calls.some(([path]) => String(path).includes("page=2&hash") && String(path).endsWith("retry=true"))).toBe(true);
    });

    it("offers the latest version when the file changed, instead of a retry that cannot work", async () => {
      vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("cloud_file_conflict", "changed", 409));
      const onStale = vi.fn();
      render(<DocumentPreview file={file} onStale={onStale} />);
      expect((await screen.findByRole("alert")).textContent).toMatch(/updated since you opened it/);
      expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Load latest version" }));
      expect(onStale).toHaveBeenCalledOnce();
    });

    it("says previews are unavailable without hammering the server", async () => {
      vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("cloud_preview_unavailable", "down", 503));
      render(<DocumentPreview file={file} />);
      expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(vi.mocked(cloudApi)).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Retry preview" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps a page whose image cannot be decoded recoverable", async () => {
      render(<DocumentPreview file={file} />);
      const [first] = await images();
      fireEvent.error(first!);
      expect(await screen.findByText("This page could not be shown.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry page 1" })).toBeTruthy();
    });
  });
});

describe("Lazy page loading", () => {
  type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
  class FakeObserver {
    static all: FakeObserver[] = [];
    elements = new Set<Element>();
    constructor(public callback: (entries: Entry[]) => void, public options: IntersectionObserverInit) {
      FakeObserver.all.push(this);
    }
    observe(element: Element) { this.elements.add(element); }
    unobserve(element: Element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
    report(page: number, isIntersecting: boolean, ratio = 1) {
      const target = [...this.elements].find((element) => (element as HTMLElement).dataset.page === String(page));
      if (target) this.callback([{ target, isIntersecting, intersectionRatio: isIntersecting ? ratio : 0 }]);
    }
  }
  const nearby = () => FakeObserver.all.at(-1)!;
  // happy-dom has no layout: give pages a fixed position (500px tall plus a 12px gap) and the viewport 600px.
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const stubLayout = () => {
    const define = (name: string, get: (this: HTMLElement) => number) => {
      originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
    };
    define("offsetTop", function () {
      const page = Number(this.dataset.page);
      return page ? 12 + (page - 1) * 512 : 0;
    });
    define("clientHeight", function () {
      return this.getAttribute("role") === "region" ? 600 : 0;
    });
  };
  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    stubLayout();
    statusOnly(50);
  });
  afterEach(() => {
    for (const [name, descriptor] of originals)
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    originals.clear();
  });
  const scrollTo = (top: number) => {
    const region = screen.getByRole("region", { name: /Document preview/ });
    region.scrollTop = top;
    fireEvent.scroll(region);
  };

  it("loads only the pages near the viewport, so a long document opens at once", async () => {
    render(<DocumentPreview file={file} />);
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(50 + 2));
    // Only the first page was needed to learn the length; nothing else has been asked for.
    expect(vi.mocked(cloudApi).mock.calls.map(([path]) => pageOf(path))).toEqual([1]);
    act(() => {
      nearby().report(1, true);
      nearby().report(2, true);
    });
    await waitFor(() => expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(2));
    expect(vi.mocked(cloudApi).mock.calls.map(([path]) => pageOf(path)).sort()).toEqual([1, 2]);
  });

  it("follows the reader: the page counter tracks scrolling and distant pages load on arrival", async () => {
    render(<DocumentPreview file={file} />);
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(50 + 2));
    // The reading line sits 35% (210px) down the 600px viewport.
    act(() => scrollTo(12 + 512 - 100));
    expect(screen.getByRole("status").textContent).toBe("Page 2 of 50");
    expect(field().value).toBe("2");
    act(() => scrollTo(12 + 512 - 250));
    expect(screen.getByRole("status").textContent).toBe("Page 1 of 50");
    act(() => {
      scrollTo(12 + 29 * 512);
      nearby().report(30, true);
    });
    await waitFor(() => expect(screen.getByRole("img", { hidden: true, name: "report.pdf, page 30 of 50" })).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("Page 30 of 50");
    expect(field().value).toBe("30");
  });

  it("reads the position, not stale visibility, when a tall page leaves the screen", async () => {
    render(<DocumentPreview file={file} />);
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(50 + 2));
    // Just under the boundary: page 4 still holds the reading line; one pixel more and page 5 does.
    act(() => scrollTo(12 + 4 * 512 - 210 - 1));
    expect(screen.getByRole("status").textContent).toBe("Page 4 of 50");
    act(() => scrollTo(12 + 4 * 512 - 210));
    expect(screen.getByRole("status").textContent).toBe("Page 5 of 50");
  });
});

describe('Presentation previews', () => {
  const deck = { ...file, path: 'Quarterly review.pptx' };
  it('shows one slide, preloads neighbors, and navigates with slide controls and focused keyboard shortcuts', async () => {
    render(<DocumentPreview file={deck} />);
    await screen.findByRole('img', { name: /slide 1 of 3/ });
    expect(screen.getAllByRole('img')).toHaveLength(1);
    await waitFor(() => expect(vi.mocked(cloudApi).mock.calls.map(([path]) => pageOf(path))).toContain(2));
    expect(vi.mocked(cloudApi).mock.calls.map(([path]) => pageOf(path))).not.toContain(3);
    const field = screen.getByRole('textbox', { name: 'Slide number' });
    const next = screen.getByRole('button', { name: 'Next slide' });
    fireEvent.click(next);
    await screen.findByRole('img', { name: /slide 2 of 3/ });
    expect(screen.getByRole('button', { name: 'Next slide' })).toBe(next);
    expect(field).toHaveProperty('value', '2');
    fireEvent.keyDown(field, { key: 'ArrowRight' });
    expect(field).toHaveProperty('value', '2');
    fireEvent.keyDown(screen.getByRole('region', { name: /Presentation preview/ }), { key: 'End' });
    expect(field).toHaveProperty('value', '3');
    expect(next).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(field).toHaveProperty('value', '2');
  });

  it('fits measured slides to both dimensions and recalculates on panel resize', async () => {
    let resize!: () => void;
    let height = 224;
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(824);
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const { unmount } = render(<DocumentPreview file={deck} />);
    const image = await screen.findByRole('img', { name: /slide 1/ });
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
    const slot = screen.getByRole('group', { name: 'Slide 1 of 3' });
    expect(parseFloat(slot.style.height)).toBeLessThanOrEqual(200);
    height = 424;
    act(() => resize());
    expect(parseFloat(slot.style.height)).toBeLessThanOrEqual(400);
    expect(parseFloat(slot.style.width)).toBeGreaterThan(700);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(parseFloat(slot.style.width)).toBeGreaterThan(800);
    fireEvent.click(screen.getByRole('button', { name: 'Fit slide' }));
    expect(parseFloat(slot.style.height)).toBeLessThanOrEqual(400);
    unmount();
    widthSpy.mockRestore(); heightSpy.mockRestore();
  });

  it('uses the actual aspect ratio and recovers an image decode failure on the selected slide', async () => {
    render(<DocumentPreview file={deck} />);
    const image = await screen.findByRole('img', { name: /slide 1/ });
    Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
    const slot = screen.getByRole('group', { name: 'Slide 1 of 3' });
    expect(Math.abs(parseFloat(slot.style.height) / parseFloat(slot.style.width) - .75)).toBeLessThan(.01);
    fireEvent.error(image);
    expect(screen.getByText('This slide could not be shown.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry slide 1' }));
    await waitFor(() => expect(screen.queryByText('This slide could not be shown.')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Slide number' })).toHaveProperty('value', '1');
  });
});
