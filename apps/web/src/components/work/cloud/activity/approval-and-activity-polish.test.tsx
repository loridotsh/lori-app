import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudApproval, CloudToolInvocation } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { changedFilePaths, isReviewArtifact } from "../files/changed-paths";
import { AssistantFlow } from "./assistant-flow";
import { ToolGroup } from "./tool-group";
import { clock } from "./use-elapsed";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<object>()), cloudApi: vi.fn() }));

let seq = 0;
const tool = (name: string, args: Record<string, unknown>, extra: Partial<CloudToolInvocation> = {}): CloudToolInvocation => {
  seq++;
  return {
    id: `t${seq}`, runId: "run", roundId: "round", callId: `c${seq}`, name, arguments: args, actionHash: "h",
    status: "completed", createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.400Z", ...extra,
  };
};
const approval = (call: CloudToolInvocation, extra: Partial<CloudApproval> = {}): CloudApproval => ({
  id: `a-${call.id}`, runId: "run", invocationId: call.id, actionHash: "h", status: "pending", createdAt: call.createdAt, ...extra,
});
const noop = () => ({ onChanged: vi.fn().mockResolvedValue(undefined), onFailure: vi.fn() });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("files offered from a response", () => {
  const changed = (...files: string[]) => ({ changedFiles: files.map((path) => ({ path })) });
  it("lists the deliverables and not the screenshots Lori rendered to check them", () => {
    const calls = [
      tool("run_command", {}, { output: changed("q3-sales.xlsx", "q3-review.docx", "q3-review.pptx") }),
      tool("render_document", {}, { output: changed("page-1.png", "page-2.png", "review/page-3.png") }),
    ];
    expect(changedFilePaths(calls)).toEqual(["q3-sales.xlsx", "q3-review.docx", "q3-review.pptx"]);
  });
  it("keeps a picture the member actually asked for", () => {
    const calls = [tool("run_command", {}, { output: changed("revenue-chart.png", "logo.jpg", "slides/cover.png") })];
    expect(changedFilePaths(calls)).toEqual(["revenue-chart.png", "logo.jpg", "slides/cover.png"]);
  });
  it("drops render pictures a command produced and scratch folders, wherever they appear", () => {
    const calls = [tool("run_command", {}, { output: changed("report.pdf", "page-4.png", "tmp/work.docx", "renders/slide_2.jpg", "out/preview-1.webp", ".tmp/x.csv") })];
    expect(changedFilePaths(calls)).toEqual(["report.pdf"]);
  });
  it("still honors declines, failures, Trash and duplicates", () => {
    const calls = [
      tool("write_file", {}, { output: { file: { path: "notes.md" } } }),
      tool("write_file", {}, { output: { file: { path: "notes.md" } } }),
      tool("write_file", {}, { status: "denied", output: { file: { path: "refused.md" } } }),
      tool("manage_files", {}, { output: { trashed: true, path: "old.md" } }),
    ];
    expect(changedFilePaths(calls)).toEqual(["notes.md"]);
  });
  it("recognizes review artifacts by name", () => {
    for (const path of ["page-1.png", "a/slide_12.jpeg", "render/x.png", "Screenshots/a.png", "tmp/a.txt"]) expect(isReviewArtifact(path)).toBe(true);
    for (const path of ["pager.png", "report.pdf", "pages.docx", "preview.md", "template/page.png"]) expect(isReviewArtifact(path)).toBe(false);
  });
  it("shows no cards at all when a response only rendered screenshots", () => {
    const calls = [tool("render_document", {}, { output: changed("page-1.png", "page-2.png") })];
    render(<AssistantFlow text="Checked the layout." invocations={calls} approvals={[]} existingPaths={new Set(["page-1.png", "page-2.png"])} onOpenFile={vi.fn()} {...noop()} />);
    expect(screen.queryByRole("region", { name: "Files from this response" })).toBeNull();
    expect(screen.queryByText(/Open preview/)).toBeNull();
  });
  it("shows a card per deliverable and none for the screenshots beside them", () => {
    const calls = [
      tool("run_command", {}, { output: changed("q3-review.docx", "q3-sales.xlsx") }),
      tool("render_document", {}, { output: changed("page-1.png") }),
    ];
    render(<AssistantFlow text="Done." invocations={calls} approvals={[]} existingPaths={new Set(["q3-review.docx", "q3-sales.xlsx", "page-1.png"])} onOpenFile={vi.fn()} {...noop()} />);
    const cards = within(screen.getByLabelText("Files from this response")).getAllByRole("button");
    expect(cards.map((card) => card.getAttribute("title"))).toEqual(["q3-review.docx", "q3-sales.xlsx"]);
  });
});

describe("tool group heading", () => {
  const dots = (container: HTMLElement) => container.querySelectorAll("button .rounded-full");
  it("has no status dot in any state, and says the state in words and colour instead", () => {
    const calls = (status: CloudToolInvocation["status"]) => [tool("read_file", { path: "a" }, { status }), tool("read_file", { path: "b" }, { status })];
    const done = render(<ToolGroup invocations={calls("completed")} approvals={[]} {...noop()} />);
    expect(dots(done.container)).toHaveLength(0);
    expect(screen.getByText(/^Used 2 tools$/).className).toContain("text-muted-foreground");
    done.unmount();
    const failed = render(<ToolGroup invocations={calls("failed")} approvals={[]} {...noop()} />);
    expect(dots(failed.container)).toHaveLength(0);
    expect(screen.getByText(/failed/).className).toContain("text-destructive");
    failed.unmount();
    const call = tool("write_file", { path: "a.md", content: "x" }, { status: "pendingApproval" });
    const waiting = render(<ToolGroup invocations={[call, tool("read_file", { path: "b" })]} approvals={[approval(call)]} {...noop()} />);
    expect(dots(waiting.container)).toHaveLength(0);
    expect(screen.getByText(/Needs your approval/).className).toContain("text-warning-muted-foreground");
    waiting.unmount();
    const running = render(<ToolGroup invocations={calls("running")} approvals={[]} {...noop()} />);
    expect(dots(running.container)).toHaveLength(0);
  });
});

describe("approval card", () => {
  const command = () => tool("run_command", { command: "python build.py", timeoutSeconds: 120 }, { status: "pendingApproval" });
  it("is a flat card whose actions sit in a footer, with the primary action last", () => {
    const call = command();
    render(<ToolGroup invocations={[call]} approvals={[approval(call)]} {...noop()} />);
    const card = screen.getByRole("region", { name: "Approval needed" });
    expect(within(card).getByText("Allow this command?")).toBeTruthy();
    expect(within(card).getByText("python build.py")).toBeTruthy();
    expect(within(card).getByText(/private sandbox, with no network · stops after 120s/)).toBeTruthy();
    expect(card.querySelector("svg.lucide-shield-question")).toBeNull();
    const buttons = within(card).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Deny", "Allow once"]);
  });
  it("shows a spinner on the button that was pressed and locks both while it works", async () => {
    let finish!: () => void;
    vi.mocked(cloudApi).mockImplementation(() => new Promise<never>((resolve) => { finish = () => resolve({} as never); }));
    const call = command();
    render(<ToolGroup invocations={[call]} approvals={[approval(call)]} {...noop()} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    const allow = await screen.findByRole("button", { name: "Allow once" }) as HTMLButtonElement;
    const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    expect(allow.disabled && deny.disabled).toBe(true);
    expect(allow.querySelector("svg.lucide-loader-circle")).not.toBeNull();
    expect(deny.querySelector("svg.lucide-loader-circle")).toBeNull();
    expect(screen.getByRole("region", { name: "Approval needed" }).getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    await waitFor(() => expect(allow.disabled).toBe(false));
  });
  it("lists generated files as quiet rows with their evidence one click away", () => {
    const call = tool("run_command", { command: "x" }, { status: "pendingApproval" });
    const apply = approval(call, {
      kind: "apply_files", summary: "Apply generated files",
      files: [
        { path: "q3-review.docx", sha256: "a".repeat(64), sizeBytes: 2048, expectedHash: null },
        { path: "q3-sales.xlsx", sha256: "b".repeat(64), sizeBytes: 4096, expectedHash: "c".repeat(64) },
      ],
    });
    render(<ToolGroup invocations={[call]} approvals={[apply]} {...noop()} />);
    const card = screen.getByRole("region", { name: "Approval needed" });
    expect(within(card).getByText("Adds a new file · 2.0 KB")).toBeTruthy();
    expect(within(card).getByText("Replaces the existing file · 4.0 KB")).toBeTruthy();
    expect(within(card).getAllByRole("link", { name: /Review file/ })).toHaveLength(2);
    expect(within(card).getAllByText("File versions")).toHaveLength(2);
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reject", "Apply files"]);
  });
  it("describes plugin actions with their summary, and writes without repeating the file name", () => {
    const plugin = tool("call_plugin_tool", { pluginId: "linear", name: "create_issue", arguments: { title: "x" } }, { status: "pendingApproval" });
    const first = render(<ToolGroup invocations={[plugin]} approvals={[approval(plugin, { summary: "Create a Linear issue" })]} {...noop()} />);
    expect(screen.getByText("Create a Linear issue")).toBeTruthy();
    first.unmount();
    const write = tool("write_file", { path: "a.md", content: "hi" }, { status: "pendingApproval" });
    render(<ToolGroup invocations={[write]} approvals={[approval(write, { summary: "write_file: a.md" })]} {...noop()} />);
    expect(screen.queryByText("write_file: a.md")).toBeNull();
  });
});

describe("command rows", () => {
  it("name a script by its first line instead of running its lines together", () => {
    const script = tool("run_command", { command: "python3 - <<'PY'\nprint('a')\nprint('b')\nPY" });
    render(<ToolGroup invocations={[script]} approvals={[]} {...noop()} />);
    expect(screen.getByText("python3 - <<'PY' …")).toBeTruthy();
    cleanup();
    const single = tool("run_command", { command: "  ls -la  " });
    render(<ToolGroup invocations={[single]} approvals={[]} {...noop()} />);
    expect(screen.getByText("ls -la")).toBeTruthy();
  });
});

describe("approved work in progress", () => {
  it("says a command is queued, then running in the sandbox, with a live clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:30.000Z"));
    const queued = tool("run_command", { command: "python build.py" }, { status: "pendingExecution", updatedAt: "2026-10-13T00:00:20.000Z" });
    const view = render(<ToolGroup invocations={[queued]} approvals={[approval(queued, { status: "approved" })]} {...noop()} />);
    expect(screen.getByText("Queued for the worker")).toBeTruthy();
    expect(screen.getByText("10s")).toBeTruthy();
    const running = { ...queued, status: "running" as const };
    view.rerender(<ToolGroup invocations={[running]} approvals={[approval(running, { status: "approved" })]} {...noop()} />);
    expect(screen.getByText("Running in the sandbox")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByText("13s")).toBeTruthy();
  });
  it("keeps the stage and clock visible on a collapsed group's heading", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:01:00.000Z"));
    const running = tool("run_command", { command: "python3 build.py" }, { status: "running", updatedAt: "2026-10-13T00:00:45.000Z" });
    const other = tool("read_file", { path: "a.md" });
    render(<ToolGroup invocations={[other, running]} approvals={[]} {...noop()} />);
    const heading = screen.getByRole("button", { expanded: false });
    expect(within(heading).getByText(/Running in the sandbox · 15s/)).toBeTruthy();
  });
  it("shows nothing extra once the tool has finished", () => {
    const done = tool("run_command", { command: "ls" }, { output: { exitCode: 0, stdout: "", stderr: "" } });
    render(<ToolGroup invocations={[done]} approvals={[]} {...noop()} />);
    expect(screen.queryByText(/Running in the sandbox|Queued for the worker/)).toBeNull();
  });
  it("formats the clock compactly", () => {
    expect(clock(8)).toBe("8s");
    expect(clock(65)).toBe("1m 05s");
    expect(clock(600)).toBe("10m 00s");
  });
});
