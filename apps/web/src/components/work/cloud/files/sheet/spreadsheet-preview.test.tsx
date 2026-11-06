import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFile } from "@lori-enterprise/contracts";
import { ClientApiError } from "@/lib/client-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { pack } from "./package-fixture";
import { SpreadsheetPreview, type SheetControl } from "./spreadsheet-preview";
import { readWorkbook } from "./xlsx-read";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<object>()), cloudApi: vi.fn() }));
vi.mock("../file-preview", () => ({
  contentUrl: (id: string) => `/content/${id}`,
  BinaryCard: ({ note }: { note?: string }) => <p>{note}</p>,
  PdfPreview: ({ file }: { file: { path: string } }) => <div data-testid="pages">pages of {file.path}</div>,
}));

const kit = () => new Uint8Array(readFileSync(join(import.meta.dirname, "__fixtures__/kit-workbook.xlsx")));
const file = (extra: Partial<CloudFile> = {}): CloudFile => ({
  id: "file-1", conversationId: "c", path: "q3/sales.xlsx", mimeType: "application/octet-stream", sizeBytes: 15_000,
  sha256: "a".repeat(64), version: 1, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", ...extra,
});

function serve(bytes: Uint8Array) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })));
}

interface Mounted {
  control: { current: SheetControl | null };
  saved: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  stale: ReturnType<typeof vi.fn>;
}
function mount(options: { file?: CloudFile; disabled?: boolean } = {}): Mounted {
  const control: Mounted["control"] = { current: null };
  const saved = vi.fn();
  const failed = vi.fn();
  const stale = vi.fn();
  render(<SpreadsheetPreview file={options.file ?? file()} disabled={options.disabled ?? false} controlRef={control} onSaved={saved} onFailure={failed} onStale={stale} />);
  return { control, saved, failed, stale };
}

const grid = () => screen.getByRole("grid");
const cell = (address: string) => grid().querySelector(`[data-cell="${address}"]`) as HTMLElement | null;
const nameBox = () => screen.getByLabelText("Selected cell") as HTMLInputElement;
const bar = () => screen.getByLabelText("Formula bar") as HTMLInputElement;
async function ready() {
  await screen.findByRole("grid");
}
function jump(address: string) {
  fireEvent.focus(nameBox());
  fireEvent.change(nameBox(), { target: { value: address } });
  fireEvent.keyDown(nameBox(), { key: "Enter" });
}
function typeInto(text: string) {
  fireEvent.keyDown(grid(), { key: text[0] });
  const input = screen.getByRole("textbox", { name: /^Edit / });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

beforeEach(() => {
  vi.mocked(cloudApi).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("opening a workbook", () => {
  it("shows editing gridlines even when the saved workbook hides them, without changing that preference", async () => {
    serve(pack('<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'));
    const { control } = mount();
    await ready();
    expect(grid().querySelectorAll('[data-gridline]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Gridlines" }));
    expect(grid().querySelectorAll('[data-gridline]')).toHaveLength(0);
    expect(control.current?.dirty).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Gridlines" }));
    jump("A1");
    fireEvent.keyDown(typeInto("2"), { key: "Enter" });
    vi.mocked(cloudApi).mockResolvedValue(file({ version: 2, sha256: "b".repeat(64) }));
    await act(async () => { await control.current!.save(); });
    const body = vi.mocked(cloudApi).mock.calls[0]![1]!.body as Blob;
    expect(readWorkbook(new Uint8Array(await body.arrayBuffer())).workbook.sheets[0]!.showGridLines).toBe(false);
  });
  it("opens on the tab the file was saved on, with formatted values and every sheet as a tab", async () => {
    serve(kit());
    mount();
    expect(screen.getByRole("status").textContent).toContain("Opening workbook");
    await ready();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["EMEA", "APAC", "AMER", "Summary"]);
    expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
    expect(cell("B6")!.textContent).toMatch(/^\$[\d,]+$/);
    expect(cell("B2")!.textContent).toBe("Q3 sales summary");
    expect(screen.getByText(/Charts and images on this sheet are not drawn here/)).toBeTruthy();
  });

  it("shows the formula and address of the selected cell and moves with the keyboard", async () => {
    serve(kit());
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("G6");
    expect(nameBox().value).toBe("G6");
    expect(bar().value).toBe("=E6*F6");
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(nameBox().value).toBe("F6");
    expect(bar().value).toBe("1182");
    fireEvent.keyDown(grid(), { key: "ArrowDown", shiftKey: true });
    expect(nameBox().value).toBe("F6:F7");
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(nameBox().value).toBe("A6");
  });

  it("falls back to page images, saying why, when the file is not a workbook", async () => {
    serve(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    mount();
    await screen.findByTestId("pages");
    expect(screen.getByRole("note").textContent).toMatch(/not an \.xlsx workbook/);
  });

  it("falls back for a workbook that is too large to open here", async () => {
    serve(kit());
    mount({ file: file({ sizeBytes: 50 * 1024 * 1024 }) });
    await screen.findByTestId("pages");
    expect(screen.getByRole("note").textContent).toMatch(/too large/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  it("edits a cell, recalculates what depends on it, and marks the workbook unsaved", async () => {
    serve(kit());
    const { control } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    expect(cell("G6")!.textContent).toBe("$24,822");
    const input = typeInto("100");
    expect(bar().value).toBe("100");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cell("E6")!.textContent).toBe("100");
    expect(cell("G6")!.textContent).toBe("$118,200");
    expect(cell("G7")!.textContent).toBe("$8,320"); // another row is untouched
    expect(nameBox().value).toBe("E7"); // Enter moves down
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
    expect(control.current?.dirty).toBe(true);
  });

  it("cancels with Escape and leaves the cell alone", async () => {
    serve(kit());
    const { control } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    const input = typeInto("999");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cell("E6")!.textContent).toBe("21");
    expect(control.current?.dirty).toBe(false);
  });

  it("accepts text and formulas from the formula bar", async () => {
    serve(kit());
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("D4");
    fireEvent.focus(bar());
    fireEvent.change(bar(), { target: { value: "=SUM(E6:E25)*2" } });
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(cell("D4")!.textContent).toBe("834");
    jump("D4");
    expect(bar().value).toBe("=SUM(E6:E25)*2");
  });

  it("undoes and redoes", async () => {
    serve(kit());
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("7"), { key: "Enter" });
    expect(cell("E6")!.textContent).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(cell("E6")!.textContent).toBe("21");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(cell("E6")!.textContent).toBe("7");
    fireEvent.keyDown(grid(), { key: "z", ctrlKey: true });
    expect(cell("E6")!.textContent).toBe("21");
  });

  it("clears the selection with Delete and copies it as tab-separated text", async () => {
    serve(kit());
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6:F6");
    const data = new Map<string, string>();
    fireEvent.copy(grid(), { clipboardData: { setData: (type: string, value: string) => data.set(type, value), getData: () => "" } });
    expect(data.get("text/plain")).toBe("21\t1182");
    fireEvent.keyDown(grid(), { key: "Delete" });
    expect(cell("E6")?.textContent ?? "").toBe("");
  });

  it("pastes a block starting at the selected cell", async () => {
    serve(kit());
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.paste(grid(), { clipboardData: { getData: () => "1\t2\n3\t4", setData: () => {} } });
    expect([cell("E6")!.textContent, cell("F6")!.textContent, cell("E7")!.textContent, cell("F7")!.textContent]).toEqual(["1", "$2", "3", "$4"]);
  });

  it("does not edit while Lori is working", async () => {
    serve(kit());
    mount({ disabled: true });
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(grid(), { key: "5" });
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
    expect(bar().readOnly).toBe(true);
  });

  it("will not edit inside an array formula", async () => {
    serve(pack('<sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A2">{1;2}</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'));
    mount();
    await ready();
    jump("A2");
    expect(bar().readOnly).toBe(true);
    expect(bar().title).toMatch(/array formula/);
    fireEvent.keyDown(grid(), { key: "9" });
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  });
});

describe("saving", () => {
  it("preserves an open draft across a remote update and includes it in the downloaded copy", async () => {
    serve(kit());
    const control: Mounted["control"] = { current: null };
    const props = { disabled: false, controlRef: control, onSaved: vi.fn(), onFailure: vi.fn(), onStale: vi.fn() };
    const view = render(<SpreadsheetPreview {...props} file={file()} />);
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    typeInto("100");
    view.rerender(<SpreadsheetPreview {...props} file={file({ version: 2, sha256: "b".repeat(64) })} />);
    await act(async () => { expect(await control.current!.save()).toBe(false); });
    expect(cloudApi).not.toHaveBeenCalled();
    let copy!: Blob;
    const url = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { copy = blob as Blob; return "blob:copy"; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      fireEvent.click(screen.getByRole("button", { name: "Download my copy" }));
      expect(readWorkbook(new Uint8Array(await copy.arrayBuffer())).workbook.sheets[0]!.cells.get(5 * 16384 + 4)!.value).toBe(100);
      expect(cloudApi).not.toHaveBeenCalled();
    } finally {
      url.mockRestore();
      click.mockRestore();
    }
  });

  it("commits and saves an open cell draft before allowing the panel to close", async () => {
    serve(kit());
    vi.mocked(cloudApi).mockResolvedValue(file({ version: 2, sha256: "b".repeat(64) }));
    const { control } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    typeInto("100"); // no Enter or blur before the parent asks to close
    expect(control.current!.dirty).toBe(true);
    await act(async () => { expect(await control.current!.save()).toBe(true); });
    const body = vi.mocked(cloudApi).mock.calls[0]![1]!.body as Blob;
    expect(readWorkbook(new Uint8Array(await body.arrayBuffer())).workbook.sheets[0]!.cells.get(5 * 16384 + 4)!.value).toBe(100);
    expect(control.current!.dirty).toBe(false);
  });
  it("keeps the loaded version as the save precondition when a newer file arrives during edits", async () => {
    serve(kit());
    const control: Mounted["control"] = { current: null };
    const props = { disabled: false, controlRef: control, onSaved: vi.fn(), onFailure: vi.fn(), onStale: vi.fn() };
    const view = render(<SpreadsheetPreview {...props} file={file()} />);
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    view.rerender(<SpreadsheetPreview {...props} file={file({ version: 2, sha256: "b".repeat(64) })} />);
    expect(bar().readOnly).toBe(true);
    fireEvent.keyDown(grid(), { key: "z", ctrlKey: true });
    expect(cell("E6")!.textContent).toBe("100");
    vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("cloud_file_conflict", "The file changed.", 409));
    await act(async () => { expect(await control.current!.save()).toBe(false); });
    expect(String(vi.mocked(cloudApi).mock.calls[0]![0])).toContain(`expectedVersion=1&expectedHash=${"a".repeat(64)}`);
    expect(cell("E6")!.textContent).toBe("100");
    expect(control.current!.dirty).toBe(true);
  });

  it("does not allow closing when another edit arrives while a save is in flight", async () => {
    serve(kit());
    let finish!: (file: CloudFile) => void;
    vi.mocked(cloudApi).mockImplementation(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
    const { control } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    let saving!: Promise<boolean>;
    act(() => { saving = control.current!.save(); });
    await waitFor(() => expect(cloudApi).toHaveBeenCalledTimes(1));
    jump("E7");
    fireEvent.keyDown(typeInto("5"), { key: "Enter" });
    await act(async () => {
      finish(file({ version: 2, sha256: "b".repeat(64) }));
      expect(await saving).toBe(false);
    });
    expect(control.current!.dirty).toBe(true);
    expect(cell("E7")!.textContent).toBe("5");
  });
  it("writes the edited workbook back as the next version of the same file", async () => {
    serve(kit());
    const next = file({ version: 2, sha256: "b".repeat(64) });
    vi.mocked(cloudApi).mockResolvedValue(next);
    const { control, saved } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    await act(async () => {
      expect(await control.current!.save()).toBe(true);
    });
    expect(cloudApi).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(cloudApi).mock.calls[0]!;
    expect(String(path)).toMatch(/^\/files\/file-1\/content\?requestId=[0-9a-f-]{36}&expectedVersion=1&expectedHash=a{64}$/);
    expect(init?.method).toBe("PUT");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
    const body = new Uint8Array(await (init!.body as Blob).arrayBuffer());
    const reread = readWorkbook(body).workbook;
    expect(reread.sheets[0]!.cells.get(5 * 16384 + 4)!.value).toBe(100);
    expect(saved).toHaveBeenCalledWith(next);
    expect(control.current?.dirty).toBe(false);
    expect(screen.getByText("Saved")).toBeTruthy();
    // The next save is against the version the server just returned.
    jump("E7");
    fireEvent.keyDown(typeInto("5"), { key: "Enter" });
    vi.mocked(cloudApi).mockResolvedValue(file({ version: 3, sha256: "c".repeat(64) }));
    await act(async () => {
      await control.current!.save();
    });
    expect(String(vi.mocked(cloudApi).mock.calls[1]![0])).toContain(`expectedVersion=2&expectedHash=${"b".repeat(64)}`);
  });

  it("saves by itself shortly after the last edit", async () => {
    serve(kit());
    vi.mocked(cloudApi).mockResolvedValue(file({ version: 2, sha256: "b".repeat(64) }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount();
      await ready();
      fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
      jump("E6");
      fireEvent.keyDown(typeInto("100"), { key: "Enter" });
      expect(cloudApi).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(cloudApi).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the edits and offers a copy when the file changed somewhere else", async () => {
    serve(kit());
    vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("cloud_file_conflict", "The file changed.", 409));
    const { control, stale } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    await act(async () => {
      expect(await control.current!.save()).toBe(false);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed somewhere else/);
    expect(within(alert).getByRole("button", { name: "Download my copy" })).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(cell("E6")!.textContent).toBe("100"); // nothing was lost
    expect(control.current?.dirty).toBe(true);
    // Further edits are refused until the member decides.
    jump("E7");
    fireEvent.keyDown(grid(), { key: "5" });
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(within(alert).getByRole("button", { name: "Load latest version" }));
    expect(stale).toHaveBeenCalled();
  });

  it("offers to retry when the network failed, and succeeds the second time", async () => {
    serve(kit());
    vi.mocked(cloudApi).mockRejectedValueOnce(new ClientApiError("network_unavailable", "Could not be reached.", 0)).mockResolvedValue(file({ version: 2, sha256: "b".repeat(64) }));
    const { control } = mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    await act(async () => {
      await control.current!.save();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(control.current?.dirty).toBe(false));
    // The retry carries the same request id, so the server can recognise a save it already has.
    const ids = vi.mocked(cloudApi).mock.calls.map(([path]) => /requestId=([^&]+)/.exec(String(path))![1]);
    expect(ids[0]).toBe(ids[1]);
  });

  it("shows the saved pages after saving, and not before", async () => {
    serve(kit());
    vi.mocked(cloudApi).mockResolvedValue(file({ version: 2, sha256: "b".repeat(64) }));
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "EMEA" }));
    jump("E6");
    fireEvent.keyDown(typeInto("100"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    await screen.findByTestId("pages");
    expect(cloudApi).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Sheet" }));
    expect(screen.getByRole("grid")).toBeTruthy();
  });
});
