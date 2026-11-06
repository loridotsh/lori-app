import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFile } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { CloudFiles } from "./cloud-files";
import { pack } from "./files/sheet/package-fixture";
import { readWorkbook } from "./files/sheet/xlsx-read";
vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<object>()), cloudApi: vi.fn() }));
const file: CloudFile = { id: "file", conversationId: "chat", path: "report.md", mimeType: "text/markdown", sizeBytes: 10, sha256: "oldhash", version: 3, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const second = { ...file, id: "second", path: "second.md" };
const patches = () => vi.mocked(cloudApi).mock.calls.filter(([, init]) => init?.method === "PATCH");
const body = (index = 0) => JSON.parse(String(patches()[index]![1]!.body));
const defaults = () => ({ conversationId: "chat", files: [file], disabled: false, onFiles: vi.fn(), onClose: vi.fn(), onFailure: vi.fn() });
function mount(overrides: Partial<ComponentProps<typeof CloudFiles>> = {}) {
  const props = { ...defaults(), ...overrides };
  return { ...render(<CloudFiles {...props} />), props };
}
async function edit() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("textbox", { name: "File content" }) as Promise<HTMLTextAreaElement>;
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Unconfigured test network request"); }));
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/files")) return { files: [file, second] };
    if (init?.method === "PATCH") return { ...file, version: 4, sha256: "newhash" };
    return { file: path.includes("second") ? second : file, text: "# Original", truncated: false };
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Cloud file preview and autosave", () => {
  const artifact = { version: 1, title: "Source-grounded study guide", summary: "Study the selected chapter.", sources: [{ label: "Selected chapter", reference: "chapter.pdf; SHA-256 source-hash; page 3" }], blocks: [{ type: "flashcards", title: "Chapter review", cards: [{ front: "What is isolation?", back: "Keeping each workspace separate." }] }] };
  const artifactFile = { ...file, path: "study.lori.json", mimeType: "application/json" };
  it("previews an artifact in the existing file panel without exporting or persisting local study state", async () => {
    vi.mocked(cloudApi).mockImplementation(async path => path.endsWith("/files") ? { files: [artifactFile] } : { file: artifactFile, text: JSON.stringify(artifact), truncated: false, nextOffset: null });
    mount({ files: [artifactFile], allowExport: false, readOnly: true });
    expect(await screen.findByText(artifact.sources[0]!.reference)).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: artifact.title })).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: artifactFile.path })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show answer$/ }));
    expect(screen.getByRole("button", { name: /^Answer: Keeping each workspace separate\./ }).getAttribute("aria-pressed")).toBe("true");
    expect(patches()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Download visual data" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Open ${artifact.title} in a larger view` }));
    expect(screen.getAllByRole("button", { name: /Show answer$/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "File content" })).toHaveProperty("readOnly", true);
  });
  it("keeps malformed artifacts inspectable through the existing Edit control", async () => {
    vi.mocked(cloudApi).mockImplementation(async path => path.endsWith("/files") ? { files: [artifactFile] } : { file: artifactFile, text: '{"script":"delete()"}', truncated: false });
    mount({ files: [artifactFile] });
    await screen.findByText(/This artifact is invalid/);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "File content" })).toHaveProperty("value", '{"script":"delete()"}');
  });
  it("refreshes a clean saved artifact after an agent creates a newer file version", async () => {
    const next = { ...artifactFile, version: 4, sha256: "newhash" };
    let current = artifactFile;
    vi.mocked(cloudApi).mockImplementation(async path => path.endsWith("/files") ? { files: [current] } : { file: current, text: JSON.stringify({ ...artifact, title: current.version === 4 ? "Revised guide" : artifact.title }), truncated: false });
    const view = mount({ files: [artifactFile] });
    await screen.findByText(artifact.sources[0]!.reference);
    current = next;
    view.rerender(<CloudFiles {...view.props} files={[next]} />);
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Revised guide" })).toHaveLength(2));
    expect(screen.queryByRole("heading", { name: artifact.title })).toBeNull();
    expect(patches()).toHaveLength(0);
  });
  it("publishes a saved workbook version before close even if the follow-up list request stalls", async () => {
    const workbook = pack('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>');
    const sheet = { ...file, path: "sheet.xlsx", mimeType: "application/octet-stream", sha256: "a".repeat(64) };
    const saved = { ...sheet, version: 4, sha256: "b".repeat(64) };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength) })));
    let committed = false;
    vi.mocked(cloudApi).mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") { committed = true; return saved; }
      if (committed) return new Promise(() => {});
      return { files: [sheet] };
    });
    const { props } = mount({ files: [sheet] });
    const grid = await screen.findByRole("grid");
    fireEvent.keyDown(grid, { key: "2" });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onFiles).toHaveBeenLastCalledWith([saved]);
  });

  it("downloads an unsaved spreadsheet as a workbook instead of an empty text blob", async () => {
    const workbook = pack('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>');
    const sheet = { ...file, path: "sheet.xlsx", mimeType: "application/octet-stream" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength) })));
    vi.mocked(cloudApi).mockResolvedValue({ files: [sheet] });
    let copy!: Blob;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { copy = blob as Blob; return "blob:workbook"; });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount({ files: [sheet] });
    fireEvent.keyDown(await screen.findByRole("grid"), { key: "9" });
    fireEvent.click(screen.getByRole("link", { name: "Download file" }));
    expect(readWorkbook(new Uint8Array(await copy.arrayBuffer())).workbook.sheets[0]!.cells.get(0)!.value).toBe(9);
    expect(vi.mocked(cloudApi).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("opens the document directly without explorer, upload or destructive actions", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Original" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download file" })).toBeTruthy();
    for (const name of ["Back to files", "Upload", "Attach", "Save changes", "Delete file"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });
  it("debounces edits and saves once with the displayed version and hash", async () => {
    mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "first" } });
    fireEvent.change(editor, { target: { value: "final" } });
    expect(patches()).toHaveLength(0);
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 1600 });
    expect(body()).toMatchObject({ expectedVersion: 3, expectedHash: "oldhash", text: "final" });
    expect(body().requestId).toBeTruthy();
    await screen.findByText("All changes saved");
  });
  it("accepts typing during a save and serializes it against the returned version", async () => {
    let finish!: (file: CloudFile) => void;
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => init?.method === "PATCH" ? new Promise((resolve) => { finish = resolve; }) : normal(path, init));
    mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "first" } }); fireEvent.blur(editor);
    await screen.findByText("Saving…");
    expect(editor.readOnly).toBe(false);
    fireEvent.change(editor, { target: { value: "second" } });
    expect(patches()).toHaveLength(1);
    await act(async () => finish({ ...file, version: 4, sha256: "newhash" }));
    await waitFor(() => expect(patches()).toHaveLength(2), { timeout: 1600 });
    expect(body(1)).toMatchObject({ expectedVersion: 4, expectedHash: "newhash", text: "second" });
    await act(async () => finish({ ...file, version: 5, sha256: "finalhash" }));
    await screen.findByText("All changes saved"); expect(editor.value).toBe("second");
  });
  it("flushes pending edits before closing", async () => {
    const { props } = mount();
    fireEvent.change(await edit(), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(body().text).toBe("keep me");
  });
  it("saves before switching to another file", async () => {
    mount({ files: [file, second] });
    fireEvent.change(await edit(), { target: { value: "keep me" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Preview file" }), { target: { value: "second" } });
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("second"));
    expect(body().text).toBe("keep me");
  });
  it.each([409, 404, 503, 0])("preserves the draft and prevents automatic retries after HTTP %s", async (status) => {
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => init?.method === "PATCH" ? Promise.reject(new ClientApiError("conflict", "The file changed", status)) : normal(path, init));
    const { props } = mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "precious draft" } }); fireEvent.blur(editor);
    await screen.findByRole("alert"); expect(editor.value).toBe("precious draft");
    expect(screen.getByRole("button", { name: "Download draft" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(props.onClose).not.toHaveBeenCalled(); expect(patches()).toHaveLength(1);
  });
  it("never saves a truncated preview over the complete file", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ file, text: "partial", truncated: true });
    mount(); const editor = await edit(); expect(editor.readOnly).toBe(true);
    fireEvent.change(editor, { target: { value: "partial edit" } }); fireEvent.blur(editor);
    expect(patches()).toHaveLength(0);
  });
  it("keeps Windows line endings on save", async () => {
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => path.includes("/text") ? Promise.resolve({ file, text: "one\r\ntwo\r\n", truncated: false }) : normal(path, init));
    mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "one\ntwo\nthree\n" } }); fireEvent.blur(editor);
    await waitFor(() => expect(patches()).toHaveLength(1)); expect(body().text).toBe("one\r\ntwo\r\nthree\r\n");
  });
  it("does not publish a late save into another conversation", async () => {
    let finish!: (file: CloudFile) => void;
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => init?.method === "PATCH" ? new Promise((resolve) => { finish = resolve; }) : normal(path, init));
    const view = mount(); fireEvent.change(await edit(), { target: { value: "old conversation" } }); fireEvent.blur(screen.getByRole("textbox"));
    await screen.findByText("Saving…");
    view.rerender(<CloudFiles {...view.props} conversationId="other" files={[]} />);
    await act(async () => finish({ ...file, version: 4 }));
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText(/Version 4/)).toBeNull();
  });
  it("loads chat file requests under Strict Mode and reports missing files", async () => {
    const props = defaults();
    const view = render(<StrictMode><CloudFiles {...props} openRequest={{ path: "second.md", nonce: 1 }} /></StrictMode>);
    await screen.findByRole("heading", { name: "Original" });
    expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("/second/text"))).toBe(true);
    view.rerender(<StrictMode><CloudFiles {...props} openRequest={{ path: "missing.md", nonce: 2 }} /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That file is no longer in this conversation.");
  });
  it("renders edited Markdown safely and CSV as a table", async () => {
    const view = mount(); fireEvent.change(await edit(), { target: { value: "# Changed\n<script>alert(1)</script>" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("heading", { name: "Changed" })).toBeTruthy(); expect(view.container.querySelector("script")).toBeNull(); view.unmount();
    const csv = { ...file, path: "sales.csv", mimeType: "text/csv" };
    vi.mocked(cloudApi).mockResolvedValue({ file: csv, text: 'region,total\n"East, North",10', truncated: false });
    mount({ files: [csv] }); expect(await screen.findByRole("cell", { name: "East, North" })).toBeTruthy();
  });
  it("shows binary files as downloads without fetching text", async () => {
    mount({ files: [{ ...file, path: "archive.zip", mimeType: "application/zip" }] });
    expect(await screen.findByText(/can't be previewed here/)).toBeTruthy();
    expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("/text"))).toBe(false);
    expect(screen.getByRole("link", { name: "Download file" })).toBeTruthy();
  });
  it("falls back safely when an image fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    mount({ files: [{ ...file, path: "logo.png", mimeType: "image/png" }] });
    expect(await screen.findByText(/couldn't be shown/)).toBeTruthy(); expect(screen.getByRole("link", { name: "Download file" })).toBeTruthy();
  });
  it("does not lose the close click to a blur-triggered save", async () => {
    const { props } = mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "keep this" } });
    const close = screen.getByRole("button", { name: "Close preview" });
    fireEvent.blur(editor, { relatedTarget: close });
    expect(patches()).toHaveLength(0);
    fireEvent.click(close);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(body().text).toBe("keep this");
  });
  it("guards page unload while a save is in flight and releases it afterwards", async () => {
    let finish!: (file: CloudFile) => void;
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => init?.method === "PATCH" ? new Promise((resolve) => { finish = resolve; }) : normal(path, init));
    mount(); const editor = await edit();
    fireEvent.change(editor, { target: { value: "edit" } }); fireEvent.blur(editor);
    await screen.findByText("Saving…");
    const pending = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    await act(async () => finish({ ...file, version: 4 }));
    await screen.findByText("All changes saved");
    const settled = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(settled);
    expect(settled.defaultPrevented).toBe(false);
  });
  it("keeps PDF downloads available when the private renderer is unavailable", async () => {
    // Cover the initial image peek too; never depend on another app running on localhost.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "cloud_preview_unavailable" }), { status: 503, headers: { "content-type": "application/json" } })));
    const normal = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) => path.includes("/preview")
      ? Promise.reject(new ClientApiError("cloud_preview_unavailable", "Preview unavailable", 503)) : normal(path, init));
    mount({ files: [{ ...file, path: "report.pdf", mimeType: "application/pdf" }] });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Document previews are temporarily unavailable. You can still download the file.");
    expect(screen.getByRole("link", { name: "Download file" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open PDF" })).toBeNull();
  });
  it("reopens the latest version of a document that changed while it was open", async () => {
    const stale = { ...file, path: "report.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), version: 1 };
    const latest = { ...stale, sha256: "b".repeat(64), version: 2 };
    let current = stale;
    // Like the server: a page of a version that is no longer current is refused, not served.
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      /hash=([a-f0-9]+)/.exec(String(url))?.[1] !== latest.sha256
        ? new Response(JSON.stringify({ error: "cloud_file_conflict", message: "The file changed." }), { status: 409 })
        : new Response(new Blob(["png"], { type: "image/png" }), { headers: { "x-total-pages": "1" } }),
    ));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:page");
    vi.mocked(cloudApi).mockImplementation(async (path) => {
      if (path.endsWith("/files")) { const listed = current; current = latest; return { files: [listed] }; }
      const hash = /hash=([a-f0-9]+)/.exec(path)?.[1];
      if (hash !== latest.sha256) throw new ClientApiError("cloud_file_conflict", "The file changed.", 409);
      return { status: "ready", page: 1, totalPages: 1 };
    });
    const onFiles = vi.fn();
    mount({ files: [stale], onFiles });
    expect((await screen.findByRole("alert")).textContent).toMatch(/updated since you opened it/);
    expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load latest version" }));
    expect(await screen.findByRole("img", { name: "report.pdf, page 1 of 1" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onFiles).toHaveBeenLastCalledWith([latest]);
  });
  it("releases an image object URL when its preview is closed", async () => {
    const revoke = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]))));
    const view = mount({ files: [{ ...file, path: "logo.png", mimeType: "image/png" }] });
    expect((await screen.findByRole("img", { name: "logo.png" })).getAttribute("src")).toBe("blob:preview");
    view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:preview");
  });
  it("keeps uploaded SVG previews out of the application's origin", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.clear()</script></svg>';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(svg)));
    mount({ files: [{ ...file, path: "logo.svg", mimeType: "image/svg+xml" }] });
    const image = await screen.findByRole("img", { name: "logo.svg" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(new URL(image.getAttribute("src")!).origin).toBe("null");
    expect(create).not.toHaveBeenCalled();
  });
  it("contains mobile focus and restores the opener on Escape", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    function Task() {
      const [opened, setOpened] = useState(false); const trigger = useRef<HTMLButtonElement>(null);
      return <><button ref={trigger} onClick={() => setOpened(true)}>Open preview</button>{opened && <CloudFiles {...defaults()} returnFocusRef={trigger} onClose={() => setOpened(false)} />}</>;
    }
    render(<Task />); const trigger = screen.getByRole("button", { name: "Open preview" }); fireEvent.click(trigger);
    await screen.findByRole("heading", { name: "Original" });
    expect(screen.getByRole("dialog", { name: "File preview" }).getAttribute("aria-modal")).toBe("true"); expect(trigger.inert).toBe(true);
    const close = screen.getByRole("button", { name: "Close preview" }); expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.inert).toBe(false); expect(document.activeElement).toBe(trigger);
  });
});
