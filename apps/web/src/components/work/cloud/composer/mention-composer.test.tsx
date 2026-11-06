import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudFile } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { useMentionOptions } from "./mention-picker";
import { CloudComposer } from "../cloud-composer";

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));

const file = (path: string, size = 2048): CloudFile => ({
  id: `id-${path}`, conversationId: "c", path, mimeType: "text/plain", sizeBytes: size,
  sha256: "h", version: 1, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
});

const submitted = vi.fn();
function Harness({
  files = [file("notes/plan.md"), file("budget.xlsx"), file("Trash/old.md")],
  extensionsAvailable = false,
  initial = "",
}: {
  files?: CloudFile[];
  extensionsAvailable?: boolean;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <form onSubmit={(event) => { event.preventDefault(); submitted(value); }}>
      <CloudComposer
        value={value} onChange={setValue} textareaRef={ref} disabled={false} controlsDisabled={false}
        sendDisabled={false} running={false} stopDisabled={false} onStop={() => {}} providers={[]}
        gatewayId="" modelId="" onModel={() => {}} files={files} attachments={[]}
        onRemoveAttachment={() => {}} filesAvailable onUpload={() => {}} onFiles={() => {}}
        fileDirty={false} extensionsAvailable={extensionsAvailable}
      />
    </form>
  );
}
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (text: string) => { fireEvent.focus(box()); fireEvent.change(box(), { target: { value: text } }); };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("@ mentions in the composer", () => {
  it("has no separate mention button", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Mention a file, plugin or skill" })).toBeNull();
  });
  it("uses the project catalog and ignores late results from the previous project", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(cloudApi).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ plugins: [], skills: [] });
    const { result, rerender } = renderHook(({ projectId }) => useMentionOptions([], true, true, projectId), { initialProps: { projectId: "first" } });
    expect(cloudApi).toHaveBeenCalledWith("/projects/first/extensions", expect.any(Object));
    rerender({ projectId: "second" });
    await waitFor(() => expect(cloudApi).toHaveBeenCalledWith("/projects/second/extensions", expect.any(Object)));
    await act(async () => finish({ plugins: [{ id: "github", name: "GitHub", allowed: true, connection: { enabled: true, status: "connected" } }], skills: [] }));
    expect(result.current).toEqual([]);
  });
  it("suggests files as you type after @ and inserts the choice without sending", async () => {
    render(<Harness />);
    type("Summarize @pl");
    const list = await screen.findByRole("listbox", { name: /Mention a file/ });
    expect(list.querySelectorAll("[role=option]")).toHaveLength(1);
    expect(screen.getByText("notes/plan.md")).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("Summarize @notes/plan.md ");
    // Choosing a suggestion must not submit the form.
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("shows each reference only in the editable message and supports normal deletion", async () => {
    render(<Harness initial='Compare @notes/plan.md and @budget.xlsx' />);
    expect(screen.queryByLabelText("Mentioned references")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove mention/ })).toBeNull();
    box().focus(); box().setSelectionRange(8, box().value.indexOf("and"));
    await userEvent.keyboard("{Backspace}");
    expect(box().value).toBe("Compare and @budget.xlsx");
  });
  it("keeps Shift Enter and empty-result Tab available to the textarea", () => {
    render(<Harness />); type("@unknown");
    expect(fireEvent.keyDown(box(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
  });
  it("closes suggestions when focus leaves and reopens on focus", () => {
    render(<Harness />); type("@pl");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.blur(box()); expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(box()); expect(screen.getByRole("listbox")).toBeTruthy();
  });
  it("replaces the suffix when selecting from inside an existing filename", () => {
    render(<Harness />); type("Read @notes/plan.md next");
    box().setSelectionRange(8, 8); fireEvent.select(box());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("Read @notes/plan.md next");
    expect(submitted).not.toHaveBeenCalled();
  });
  it("never offers files the assistant moved to Trash, and ignores emails", () => {
    render(<Harness />);
    type("@old");
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    type("write to a@plan.com");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });
  it("moves through suggestions with the arrow keys and reports the active one", async () => {
    render(<Harness />);
    type("@");
    const list = await screen.findByRole("listbox");
    const options = () => [...list.querySelectorAll("[role=option]")];
    expect(options().map((o) => o.textContent)).toEqual(["budget.xlsx2.0 KB", "notes/plan.md2.0 KB"]);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true"); // wraps
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("@notes/plan.md ");
  });
  it("closes on Escape for that mention, and Enter then sends as normal", async () => {
    render(<Harness />);
    type("see @bud");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(submitted).toHaveBeenCalledWith("see @bud");
  });
  it("picks with the mouse without losing focus from the message box", async () => {
    render(<Harness />);
    type("@bud");
    const option = await screen.findByRole("option", { name: /budget\.xlsx/ });
    const notPrevented = fireEvent.mouseDown(option);
    expect(notPrevented).toBe(false); // preventDefault keeps focus in the textbox
    expect(box().value).toBe("@budget.xlsx ");
  });
  it("quotes names with spaces and keeps text after the caret", () => {
    render(<Harness files={[file("my notes.txt")]} initial="" />);
    type("Open @my");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe('Open @"my notes.txt" ');
  });
  it("says what to do when there is nothing to mention yet", () => {
    render(<Harness files={[]} />);
    type("@");
    expect(screen.getByText(/Nothing to mention yet/)).toBeTruthy();
  });
  it("offers connected plugins and enabled skills once they load, and only those", async () => {
    vi.mocked(cloudApi).mockResolvedValue({
      callbackUrl: null,
      plugins: [
        { id: "github", name: "GitHub", auth: "oauth", docsUrl: "", setup: "", allowed: true, connection: { id: "c", revision: 1, status: "connected", enabled: true, toolCount: 1, resourceCount: 0, updatedAt: "" } },
        { id: "slack", name: "Slack", auth: "oauth", docsUrl: "", setup: "", allowed: true, connection: null },
        { id: "linear", name: "Linear", auth: "oauth", docsUrl: "", setup: "", allowed: false, connection: { id: "d", revision: 1, status: "connected", enabled: true, toolCount: 0, resourceCount: 0, updatedAt: "" } },
      ],
      skills: [
        { id: "documents", name: "Documents", description: "d", version: "1", capability: "c", references: [], allowed: true, enabled: true },
        { id: "research", name: "Research", description: "r", version: "1", capability: "c", references: [], allowed: true, enabled: false },
      ],
    });
    render(<Harness files={[]} extensionsAvailable />);
    type("@");
    await waitFor(() => expect(screen.getByText("GitHub")).toBeTruthy());
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
    expect(screen.queryByText("Linear")).toBeNull();
    expect(screen.queryByText("Research")).toBeNull();
    expect(cloudApi).toHaveBeenCalledTimes(1);
    // Typing more does not ask again.
    type("@git");
    expect(cloudApi).toHaveBeenCalledTimes(1);
  });
  it("still offers files when plugins fail to load, and tries again next time", async () => {
    vi.mocked(cloudApi).mockRejectedValue(new Error("offline"));
    render(<Harness extensionsAvailable />);
    type("@pl");
    expect(await screen.findByText("notes/plan.md")).toBeTruthy();
    await waitFor(() => expect(cloudApi).toHaveBeenCalledTimes(1));
    type("hello");
    type("@pl");
    await waitFor(() => expect(cloudApi).toHaveBeenCalledTimes(2));
  });
  it("never asks for plugins when they are unavailable", () => {
    render(<Harness extensionsAvailable={false} />);
    type("@");
    expect(cloudApi).not.toHaveBeenCalled();
  });
});
