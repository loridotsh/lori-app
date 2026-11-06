import visualFixture from "../../../../../../../packages/contracts/fixtures/artifact-fixture.json";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudApproval, CloudToolInvocation } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { AssistantFlow } from "./assistant-flow";
import { ToolGroup } from "./tool-group";

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));

let seq = 0;
function tool(
  name: string,
  args: Record<string, unknown>,
  extra: Partial<CloudToolInvocation> = {},
): CloudToolInvocation {
  seq++;
  return {
    id: `tool-${seq}`, runId: "run", roundId: "round", callId: `call-${seq}`,
    name, arguments: args, actionHash: "hash", status: "completed",
    createdAt: `2026-10-12T00:00:0${seq % 10}.000Z`,
    updatedAt: `2026-10-12T00:00:0${seq % 10}.400Z`,
    ...extra,
  };
}
const pendingApproval = (invocation: CloudToolInvocation, extra: Partial<CloudApproval> = {}): CloudApproval => ({
  id: `approval-${invocation.id}`, runId: "run", invocationId: invocation.id,
  actionHash: "hash", status: "pending", createdAt: invocation.createdAt, ...extra,
});
const noop = { onChanged: vi.fn().mockResolvedValue(undefined), onFailure: vi.fn() };
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  noop.onChanged = vi.fn().mockResolvedValue(undefined);
  noop.onFailure = vi.fn();
});

describe("ToolGroup", () => {
  it("distinguishes automatic approval from a manual decision in tool history", () => {
    const call = tool("write_file", { path: "result.md", content: "done" });
    render(<ToolGroup invocations={[call]} approvals={[pendingApproval(call, { status: "approved", decisionSource: "automatic" })]} {...noop} />);
    expect(screen.getByText("Auto-approved")).toBeTruthy();
    expect(screen.queryByText("Approved", { exact: true })).toBeNull();
  });
  it("stays collapsed with a summary, then reveals each step", () => {
    const calls = [
      tool("read_file", { path: "notes.md" }, { output: { text: "1: alpha\n2: beta" } }),
      tool("read_file", { path: "plan.md" }, { output: { text: "1: gamma" } }),
      tool("run_command", { command: "wc -l notes.md" }, { output: { exitCode: 0, stdout: "2 notes.md\n", stderr: "" } }),
    ];
    render(<ToolGroup invocations={calls} approvals={[]} {...noop} />);
    const header = screen.getByRole("button", { name: /Used 3 tools/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Read 2 files, ran 1 command")).toBeTruthy();
    expect(screen.queryByText("notes.md")).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Read notes\.md, Done/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ran wc -l notes\.md, Done/ })).toBeTruthy();
  });
  it("says what it is doing right now while a step runs", () => {
    const calls = [
      tool("read_file", { path: "a.md" }),
      tool("search_text", { query: "budget" }, { status: "running" }),
    ];
    render(<ToolGroup invocations={calls} approvals={[]} {...noop} />);
    const header = screen.getByRole("button", { name: /Searching text “budget”…/ });
    expect(header.closest("section")?.getAttribute("data-activity-state")).toBe("working");
  });
  it("shimmers a running step's words, never a spinner, and stops when it finishes", () => {
    const running = tool("run_command", { command: "npm test" }, { status: "running" });
    const { container, rerender } = render(
      <ToolGroup invocations={[running]} approvals={[]} {...noop} />,
    );
    const row = container.querySelector("li")!;
    const phrase = within(row).getByText("Running").parentElement!;
    // One sweep over verb + subject, with the tool's own (static) icon beside it.
    expect(phrase.classList.contains("text-shimmer")).toBe(true);
    expect(phrase.textContent).toBe("Runningnpm test");
    expect(row.querySelectorAll(".text-shimmer")).toHaveLength(1);
    expect(row.querySelector("svg.lucide-loader-circle")).toBeNull();
    expect(row.querySelector("[class*=animate-spin]")).toBeNull();
    rerender(
      <ToolGroup invocations={[{ ...running, status: "completed" }]} approvals={[]} {...noop} />,
    );
    expect(container.querySelector(".text-shimmer")).toBeNull();
  });
  it("shimmers the group heading only while work is live", () => {
    const calls = [
      tool("read_file", { path: "a.md" }),
      tool("search_text", { query: "budget" }, { status: "running" }),
    ];
    const { container, rerender } = render(<ToolGroup invocations={calls} approvals={[]} {...noop} />);
    const heading = screen.getByText("Searching text “budget”…");
    expect(heading.classList.contains("text-shimmer")).toBe(true);
    rerender(
      <ToolGroup invocations={[calls[0]!, { ...calls[1]!, status: "completed" }]} approvals={[]} {...noop} />,
    );
    expect(container.querySelector(".text-shimmer")).toBeNull();
    // A decision waiting on the member is not Lori working, so it must not shimmer.
    const awaiting = tool("write_file", { path: "x.md", content: "y" }, { status: "pendingApproval" });
    rerender(
      <ToolGroup invocations={[calls[0]!, awaiting]} approvals={[pendingApproval(awaiting)]} {...noop} />,
    );
    expect(container.querySelector(".text-shimmer")).toBeNull();
  });
  it("reports failures and uncertain outcomes in its heading", () => {
    const { rerender } = render(
      <ToolGroup
        invocations={[tool("run_command", { command: "x" }, { status: "failed", output: { error: "cloud_x", message: "It broke." } }), tool("read_file", { path: "a" })]}
        approvals={[]}
        {...noop}
      />,
    );
    expect(screen.getByRole("button", { name: /1 of 2 steps failed/ })).toBeTruthy();
    rerender(
      <ToolGroup
        invocations={[tool("read_file", { path: "a" }), tool("manage_files", { action: "move" }, { status: "unknown" })]}
        approvals={[]}
        {...noop}
      />,
    );
    expect(screen.getByRole("button", { name: /1 step needs verification/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 step needs verification/ }));
    // The outcome stays collapsed until the member opens that step.
    expect(screen.queryByText(/This action may have finished/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Outcome unknown/ }));
    expect(screen.getByText(/This action may have finished/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
});

describe("tool results", () => {
  function open(call: CloudToolInvocation) {
    render(<ToolGroup invocations={[call]} approvals={[]} {...noop} />);
    // A single call has no group header: its own row is the first button.
    fireEvent.click(screen.getAllByRole("button")[0]!);
  }
  it("shows command output, errors and the exit code separately", () => {
    open(tool("run_command", { command: "python report.py" }, { output: { exitCode: 2, stdout: "partial\n", stderr: "Traceback: boom" } }));
    expect(screen.getByText("python report.py", { selector: "pre" })).toBeTruthy();
    expect(screen.getByText("partial")).toBeTruthy();
    expect(screen.getByText("Error output")).toBeTruthy();
    expect(screen.getByText("Traceback: boom")).toBeTruthy();
    expect(screen.getByText("Exited with code 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeTruthy();
  });
  it("lists files with their folders and sizes", () => {
    open(tool("list_files", {}, { output: { files: [{ path: "docs/plan.md", sizeBytes: 2048 }, { path: "root.txt", sizeBytes: 12 }], truncated: true } }));
    expect(screen.getByText("plan.md")).toBeTruthy();
    expect(screen.getByText("docs/")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText(/More files match than were listed/)).toBeTruthy();
  });
  it("highlights search matches and handles no results", () => {
    open(tool("search_text", { query: "budget" }, { output: { matches: [{ path: "plan.md", line: 7, text: "The budget is final." }], truncated: false } }));
    const mark = screen.getByText("budget", { selector: "mark" });
    expect(mark).toBeTruthy();
    expect(screen.getByText("plan.md")).toBeTruthy();
    cleanup();
    open(tool("search_text", { query: "zzz" }, { output: { matches: [], truncated: false } }));
    expect(screen.getByText("No matches found.")).toBeTruthy();
  });
  it("renders file reads with a line-number gutter", () => {
    open(tool("read_file", { path: "a.md" }, { output: { text: "1: first\n2: second", truncated: true } }));
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/continues beyond/)).toBeTruthy();
  });
  it("shows what an edit changed as a diff", () => {
    open(tool("edit_file", { path: "a.md", oldText: "old line", newText: "new line", expectedHash: "x" }, { output: { file: { path: "a.md", version: 3, sizeBytes: 10 } } }));
    expect(screen.getByText(/Updated · version 3/)).toBeTruthy();
    expect(screen.getByText("old line")).toBeTruthy();
    expect(screen.getByText("new line")).toBeTruthy();
    expect(screen.getByText(/^Removed:/)).toBeTruthy();
    expect(screen.getByText(/^Added:/)).toBeTruthy();
  });
  it("never shows secrets from an unfamiliar tool's output", () => {
    open(
      tool("future_tool", {}, { output: { title: "Report", apiKey: "sk-live-secret", nested: { password: "hunter2", ok: 1 } } }),
    );
    expect(screen.getByText("Report")).toBeTruthy();
    expect(screen.getAllByText("[redacted]")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("sk-live-secret");
    expect(document.body.textContent).not.toContain("hunter2");
  });
  it("shows a plain failure message, not raw JSON", () => {
    open(tool("run_command", { command: "x" }, { status: "failed", output: { error: "cloud_exec", message: "The command timed out." } }));
    expect(screen.getByText("The command timed out.")).toBeTruthy();
  });
  it("offers the complete result when the preview was cut, and loads it once", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ fullOutput: { files: [{ path: "z.md", sizeBytes: 1 }] } });
    open(tool("list_files", {}, { output: { files: [{ path: "a.md", sizeBytes: 1 }], truncated: true } }));
    fireEvent.click(screen.getByRole("button", { name: "View complete result" }));
    expect(await screen.findByText("z.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View complete result" })).toBeNull();
    expect(cloudApi).toHaveBeenCalledWith("/runs/run/tools/" + vi.mocked(cloudApi).mock.calls[0]![0].split("/").at(-1));
  });
});

describe("approvals", () => {
  const write = () =>
    tool("write_file", { path: "report.md", content: "Reviewed content" }, { status: "pendingApproval" });
  it("keeps a pending decision visible and recoverable while its tool group is toggled", async () => {
    vi.mocked(cloudApi).mockRejectedValueOnce(new ClientApiError("offline", "Offline", 0)).mockResolvedValueOnce({});
    const call = write();
    render(<ToolGroup invocations={[tool("read_file", { path: "a.md" }), call]} approvals={[pendingApproval(call)]} {...noop} />);
    const header = screen.getByRole("button", { name: /Needs your approval · 2 tools/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await screen.findByRole("button", { name: "Check saved decision" });
    fireEvent.click(header);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Check saved decision" }));
    await waitFor(() => expect(noop.onChanged).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cloudApi).mock.calls[1]![1]!.body).toBe(vi.mocked(cloudApi).mock.calls[0]![1]!.body);
  });
  it("keeps tool output collapsed while showing the decision and binding it to the reviewed action", async () => {
    vi.mocked(cloudApi).mockResolvedValue({});
    const call = write();
    render(<ToolGroup invocations={[call]} approvals={[pendingApproval(call)]} {...noop} />);
    expect(screen.getByRole("button", { name: /Writing report\.md, Needs approval/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Apply this change?")).toBeTruthy();
    expect(screen.getByText("Reviewed content")).toBeTruthy();
    expect(screen.getByText(/creates a new file/)).toBeTruthy();
    expect(cloudApi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(noop.onChanged).toHaveBeenCalledTimes(1));
    const [path, init] = vi.mocked(cloudApi).mock.calls[0]!;
    expect(path).toBe(`/runs/run/approvals/approval-${call.id}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      actionHash: "hash", decision: "approve", requestId: expect.any(String),
    });
  });
  it("shows the command and its sandbox limits before allowing it", () => {
    const call = tool("run_command", { command: "rm -rf build && make", timeoutSeconds: 120 }, { status: "pendingApproval" });
    render(<ToolGroup invocations={[call]} approvals={[pendingApproval(call)]} {...noop} />);
    expect(screen.getByText("Allow this command?")).toBeTruthy();
    expect(screen.getByText("rm -rf build && make", { selector: "pre" })).toBeTruthy();
    expect(screen.getByText(/private sandbox, with no network · stops after 120s/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  });
  it("names the plugin and preserves every reviewable input behind one disclosure", () => {
    const call = tool(
      "call_plugin_tool",
      { pluginId: "github", name: "create_issue", connectionId: "c", arguments: { title: "Bug", token: "visible-value", body: "x".repeat(9000) } },
      { status: "pendingApproval" },
    );
    render(<ToolGroup invocations={[call]} approvals={[pendingApproval(call)]} {...noop} />);
    expect(screen.getByText("Allow this action in GitHub?")).toBeTruthy();
    expect(document.querySelectorAll("details")).toHaveLength(1);
    expect((document.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(document.body.textContent).toContain("visible-value");
    expect(document.body.textContent).toContain("x".repeat(9000));
  });
  it("reuses only the same decision after an uncertain response", async () => {
    vi.mocked(cloudApi)
      .mockRejectedValueOnce(new ClientApiError("offline", "Offline", 0))
      .mockResolvedValueOnce({});
    const call = write();
    render(<ToolGroup invocations={[call]} approvals={[pendingApproval(call)]} {...noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await screen.findByRole("button", { name: "Check saved decision" });
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check saved decision" }));
    await waitFor(() => expect(cloudApi).toHaveBeenCalledTimes(2));
    expect(vi.mocked(cloudApi).mock.calls[1]?.[1]?.body).toBe(vi.mocked(cloudApi).mock.calls[0]?.[1]?.body);
  });
  it("separates generated-file approval from the earlier tool decision", async () => {
    vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("offline", "Offline", 0));
    const call = write();
    const props = { invocations: [call], ...noop };
    const rendered = render(<ToolGroup {...props} approvals={[pendingApproval(call)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await screen.findByRole("button", { name: "Check saved decision" });
    const apply = pendingApproval(call, {
      id: "apply-approval", actionHash: "generated-hash", kind: "apply_files",
      summary: "Apply generated files",
      files: [{ path: "report.pdf", sha256: "newhash", sizeBytes: 2048, expectedHash: "oldhash" }],
    });
    rendered.rerender(<ToolGroup {...props} approvals={[apply]} />);
    expect(screen.queryByRole("button", { name: "Check saved decision" })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply files" })).toBeTruthy();
    expect(screen.getByText("Apply generated files?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review file" }).getAttribute("href")).toBe(
      `/api/v1/work/cloud/runs/run/tools/${call.id}/outputs?path=report.pdf`,
    );
  });
  it("records a decided approval on the row without asking again", () => {
    const call = tool("edit_file", { path: "a.md", oldText: "x", newText: "y" });
    render(
      <ToolGroup
        invocations={[call]}
        approvals={[pendingApproval(call, { status: "approved" })]}
        {...noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Edited a\.md/ }));
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
    // Waiting time belongs to the member, so no duration is shown beside an approval.
    expect(screen.queryByText(/\d+ms/)).toBeNull();
  });
});

describe("AssistantFlow", () => {
  it("renders visuals between Markdown sections and preserves practice state as streaming completes", () => {
    const before = "Here is the research process.\n\n";
    const call = tool("present_visual", visualFixture, { textOffset: before.length, output: { kind: "cloud_visual", presented: true } });
    const view = render(<AssistantFlow text={before + "Use the results to review the evidence."} invocations={[call]} approvals={[]} streaming {...noop} />);
    const content = view.container.textContent!;
    expect(content.indexOf("Here is the research process.")).toBeLessThan(content.indexOf(visualFixture.title));
    expect(content.indexOf(visualFixture.title)).toBeLessThan(content.indexOf("Use the results to review the evidence."));
    expect(screen.queryByRole("button", { name: /Open interactive preview/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show answer$/ }));
    view.rerender(<AssistantFlow text={before + "Use the results to review the evidence. Final note."} invocations={[structuredClone(call)]} approvals={[]} {...noop} />);
    expect(screen.getByRole("button", { name: /^Answer: .*Show question$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Final note/)).toBeTruthy();
  });
  it("interleaves text and tool activity in the order they happened", () => {
    const text = "Let me check the files. They look fine. Done.";
    const first = tool("list_files", {}, { textOffset: "Let me check the files.".length });
    const second = tool("read_file", { path: "a.md" }, { textOffset: "Let me check the files. They look fine.".length });
    const { container } = render(
      <AssistantFlow text={text} invocations={[second, first]} approvals={[]} {...noop} />,
    );
    const order = [...container.querySelectorAll("p, section[aria-label='Tool activity'], ul[aria-label='Tool activity']")].map((node) =>
      node.tagName === "P" ? node.textContent : "tools",
    );
    expect(order).toEqual(["Let me check the files.", "tools", "They look fine.", "tools", "Done."]);
  });
  it("shows tool-only turns and keeps history from before offsets existed readable", () => {
    const { container } = render(
      <AssistantFlow text="" invocations={[tool("list_files", {})]} approvals={[]} {...noop} />,
    );
    expect(within(container).getByRole("button", { name: /Listed files all files/ })).toBeTruthy();
    cleanup();
    const legacy = render(
      <AssistantFlow text="All done." invocations={[tool("list_files", {}, { textOffset: null })]} approvals={[]} {...noop} />,
    );
    const nodes = [...legacy.container.querySelectorAll("p, section[aria-label='Tool activity'], ul[aria-label='Tool activity']")];
    expect(nodes[0]!.tagName).toBe("SECTION");
    expect(nodes[1]!.textContent).toBe("All done.");
  });
  it("keeps streamed text around tool activity without an animated caret", () => {
    const call = tool("list_files", {}, { textOffset: 5 });
    const { container } = render(
      <AssistantFlow text="Hello world" invocations={[call]} approvals={[]} streaming {...noop} />,
    );
    const carets = [...container.querySelectorAll(".cloud-markdown")].filter((node) =>
      node.className.includes("after:animate-pulse"),
    );
    expect(carets).toHaveLength(0);
    expect([...container.querySelectorAll(".cloud-markdown")].map((node) => node.textContent)).toEqual(["Hello", "world"]);
  });
  describe("files from this response", () => {
    it("recovers the saved artifact title for both chat navigation and its delivery action", () => {
      const path = "runway.lori.json", title = "Cash Runway Calculator";
      const call = tool("write_file", { path, content: JSON.stringify({ ...visualFixture, title }) }, { output: { file: { path, version: 1, sizeBytes: 1000 } } });
      const onOpenFile = vi.fn();
      render(<AssistantFlow text={`Created [${path}](${path}).`} invocations={[call]} approvals={[]} existingPaths={new Set([path])} onOpenFile={onOpenFile} {...noop} />);
      const buttons = screen.getAllByRole("button", { name: `Open ${title} in workspace` });
      expect(buttons).toHaveLength(2);
      buttons.forEach(button => { fireEvent.click(button); expect(onOpenFile).toHaveBeenLastCalledWith(path); });
      expect(screen.getByText(`Artifact · ${visualFixture.blocks.length} parts · Open in workspace`)).toBeTruthy();
    });
    it("labels a saved studio artifact by its type and size", () => {
      const path = "map.lori.json";
      const map = { version: 1, title: "Market map", summary: "Themes.", blocks: [{ type: "mindmap", title: "Market map", nodes: [{ id: "root", label: "Market" }, { id: "a", parentId: "root", label: "Buyers" }] }] };
      const call = tool("write_file", { path, content: JSON.stringify(map) }, { output: { file: { path, version: 1, sizeBytes: 300 } } });
      render(<AssistantFlow text="Done." invocations={[call]} approvals={[]} existingPaths={new Set([path])} onOpenFile={vi.fn()} {...noop} />);
      expect(screen.getByRole("button", { name: "Open Market map in workspace" }).textContent).toContain("Mind map · 2 topics · Open in workspace");
    });
    const wrote = (path: string, extra: Partial<CloudToolInvocation> = {}) =>
      tool("write_file", { path, content: "x" }, { output: { file: { path, version: 1, sizeBytes: 1 } }, ...extra });
    it("offers the files the run wrote, each opening in the Files panel", () => {
      const onOpenFile = vi.fn();
      render(
        <AssistantFlow
          text="Saved."
          invocations={[wrote("reports/plan.md"), wrote("notes.md")]}
          approvals={[]}
          existingPaths={new Set(["reports/plan.md", "notes.md"])}
          onOpenFile={onOpenFile}
          {...noop}
        />,
      );
      const region = screen.getByRole("region", { name: "Files from this response" });
      fireEvent.click(within(region).getByRole("button", { name: /reports\/plan\.md/ }));
      expect(onOpenFile).toHaveBeenCalledWith("reports/plan.md");
      expect(within(region).getAllByRole("button")).toHaveLength(2);
    });
    it("leaves out files that no longer exist, unfinished writes, and the live reply", () => {
      const onOpenFile = vi.fn();
      const props = { approvals: [], onOpenFile, ...noop };
      const { rerender } = render(
        <AssistantFlow text="" invocations={[wrote("gone.md"), wrote("denied.md", { status: "denied", output: { error: "declined" } })]}
          existingPaths={new Set(["denied.md"])} {...props} />,
      );
      expect(screen.queryByRole("region", { name: "Files from this response" })).toBeNull();
      rerender(
        <AssistantFlow text="" streaming invocations={[wrote("here.md")]} existingPaths={new Set(["here.md"])} {...props} />,
      );
      expect(screen.queryByRole("region", { name: "Files from this response" })).toBeNull();
    });
    it("shows nothing where the Files panel is unavailable", () => {
      render(<AssistantFlow text="" invocations={[wrote("a.md")]} approvals={[]} existingPaths={new Set(["a.md"])} {...noop} />);
      expect(screen.queryByRole("region", { name: "Files from this response" })).toBeNull();
    });
    it("keeps every generated file reachable without an explorer", () => {
      const paths = Array.from({ length: 9 }, (_, i) => `f${i}.md`);
      render(
        <AssistantFlow text="" invocations={paths.map((path) => wrote(path))} approvals={[]}
          existingPaths={new Set(paths)} onOpenFile={vi.fn()} {...noop} />,
      );
      const region = screen.getByRole("region", { name: "Files from this response" });
      fireEvent.click(within(region).getByRole("button", { name: "Show more (5)" }));
      expect(within(region).getAllByRole("button", { name: /^Open preview/ })).toHaveLength(9);
      expect(within(region).getByRole("button", { name: /f8.md/ })).toBeTruthy();
    });
  });
});
