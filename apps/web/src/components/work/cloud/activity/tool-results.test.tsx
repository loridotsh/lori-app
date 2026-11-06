import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { GenericResult, ToolResult } from "./tool-output";

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));

let seq = 0;
function call(name: string, args: Record<string, unknown> = {}): CloudToolInvocation {
  seq++;
  return {
    id: `tool-${seq}`, runId: "run", roundId: "round", callId: `call-${seq}`,
    name, arguments: args, actionHash: "hash", status: "completed",
    createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:01.000Z",
  };
}
const show = (name: string, output: unknown, args: Record<string, unknown> = {}) =>
  render(<ToolResult invocation={call(name, args)} output={output} />);
afterEach(cleanup);

// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("plugin tool discovery", () => {
  const output = {
    kind: "plugin_tool_discovery",
    tools: [
      {
        name: "get_document", pluginId: "linear", readOnly: true, schemaHash: "abc",
        description: "Retrieve a Linear document by ID or slug",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, depth: { type: "number" } } },
        connectionId: "c-1", connectionRevision: 1,
      },
      { name: "delete_document", pluginId: "linear", readOnly: false, description: "Remove it", inputSchema: {} },
    ],
    offset: 0, nextOffset: 2, total: 9, resources: [{ name: "Docs", uri: "linear://docs", pluginId: "linear" }],
    invocationId: "11111111-1111-1111-1111-111111111111",
    hint: "Use search_plugin_tools with the same query.",
  };
  it("lists tools with their access level and inputs, and hides bookkeeping", () => {
    show("search_plugin_tools", output);
    expect(screen.getByText("9 tools found · showing 1–2")).toBeTruthy();
    expect(screen.getByText("get_document")).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.getByText("Can change data")).toBeTruthy();
    expect(screen.getByText("Retrieve a Linear document by ID or slug")).toBeTruthy();
    expect(screen.getByText("More tools are available.")).toBeTruthy();
    expect(screen.getByText("1 resource available")).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const hidden of ["invocationId", "schemaHash", "connectionId", "11111111", "Next offset", "plugin_tool_discovery"])
      expect(text).not.toContain(hidden);
  });
  it("says so when nothing matches", () => {
    show("search_plugin_tools", { kind: "plugin_tool_discovery", tools: [], total: 0, offset: 0, nextOffset: null, resources: [] });
    expect(screen.getByText("No matching tools were found.")).toBeTruthy();
  });
});

describe("skills and saved output", () => {
  it("shows what was loaded and keeps the long instructions folded", () => {
    show("load_skill", { id: "pdfs", version: "3.0.0-cloud", reference: "SKILL.md", content: "# PDFs\nUse the kit.", references: ["SKILL.md", "references/creation.md"] });
    expect(screen.getByText("Pdfs")).toBeTruthy();
    expect(screen.getByText(/version 3\.0\.0-cloud/)).toBeTruthy();
    expect(screen.getByText("references/creation.md")).toBeTruthy();
    expect(screen.getByText("Show instructions")).toBeTruthy();
  });
  it("pretty-prints a saved result that is JSON and notes that it continues", () => {
    show("read_tool_output", { text: '{"a":1,"b":[2,3]}', nextOffset: 400, invocationId: "x" });
    expect(document.querySelector("pre")?.textContent).toContain('"a": 1');
    expect(screen.getByText(/starts at position 400/)).toBeTruthy();
  });
});

describe("documents", () => {
  it("summarises an inspection with sheets and a block preview", () => {
    show("inspect_document", {
      path: "q3.xlsx", format: "xlsx", sha256: "f".repeat(64),
      parts: [{ name: "xl/styles.xml", sha256: "a" }],
      sheets: [{ name: "Summary", rows: 7, columns: 2 }, { name: "EMEA", rows: 22, columns: 6 }],
      blocks: [{ id: "b1", sheet: "Summary", cell: "B3", kind: "cell", text: "Combined sales", value: "Combined sales" }],
      totalBlocks: 120, nextOffset: 12, warnings: [],
    });
    expect(screen.getByText("q3.xlsx")).toBeTruthy();
    expect(screen.getByText(/2 sheets/)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("Summary!B3")).toBeTruthy();
    expect(screen.getByText(/of 120 items/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("ffffffff");
  });
  it("shows validation checks, warnings and the structure-only caveat", () => {
    show("validate_document", {
      path: "deck.pptx", format: "pptx", integrity: "passed", slideCount: 6, visualReview: "notReviewed",
      checks: ["File reopened successfully", "Package XML checked"], warnings: ["Slide 3 has an empty placeholder"], nextOffset: null,
    });
    expect(screen.getByText("Structure valid")).toBeTruthy();
    expect(screen.getByText("6 slides")).toBeTruthy();
    expect(screen.getByText("File reopened successfully")).toBeTruthy();
    expect(screen.getByText("Slide 3 has an empty placeholder")).toBeTruthy();
    expect(screen.getByText(/checks structure only/)).toBeTruthy();
  });
  it("shows rendered pages as thumbnails with their range", () => {
    show("render_document", {
      result: { totalPages: 9, startPage: 1, endPage: 2 },
      images: [
        { path: "render-output/page-1.png", mimeType: "image/png", data: PNG },
        { path: "render-output/page-2.png", mimeType: "image/png", data: PNG },
      ],
    });
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByAltText("Page 2")).toBeTruthy();
    expect(screen.getByText("Pages 1–2 of 9")).toBeTruthy();
  });
  it("falls back to text when no page images were kept", () => {
    show("render_document", { result: { totalPages: 3, startPage: 1, endPage: 3 }, pagesShown: 3 });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Rendered pages 1–3 of 3.")).toBeTruthy();
  });
  it("refuses image data that is not an image type", () => {
    show("view_image", { path: "x.svg", image: { data: PNG, mimeType: "image/svg+xml" } });
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("shows a viewed image", () => {
    show("view_image", { path: "chart.png", image: { data: PNG, mimeType: "image/png" } });
    expect(screen.getByAltText("chart.png")).toBeTruthy();
  });
  it("describes a conversion without a raw dump", () => {
    show("convert_document", { result: { warnings: [] }, changedFiles: [{ path: "out.pdf", sha256: "a" }] }, { path: "in.docx", outputPath: "out.pdf" });
    expect(screen.getByText("in.docx")).toBeTruthy();
    expect(screen.getByText("out.pdf")).toBeTruthy();
  });
});

describe("plugin results", () => {
  it("unpacks JSON text from a service into fields and a table", () => {
    const text = JSON.stringify({
      teams: [
        { id: "t1", key: "ASH", displayName: "Ashish", visibility: "public" },
        { id: "t2", key: "OPS", displayName: "Operations", visibility: "private" },
      ],
      hasNextPage: false,
    });
    show("call_plugin_tool", { content: [{ type: "text", text }], untrusted: true });
    expect(screen.getByText("Teams")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Display name" })).toBeTruthy();
    expect(screen.getByText("OPS")).toBeTruthy();
    expect(screen.getByText("Content from an external service.")).toBeTruthy();
    expect(document.body.textContent).not.toContain('{"teams"');
  });
  it("shows a single record as fields rather than a clipped one-row table", () => {
    show("call_plugin_tool", { content: [{ type: "text", text: JSON.stringify({ teams: [{ id: "t1", key: "ASH", createdAt: "2026-02-18", a: 1, b: 2, c: 3, d: 4 }] }) }] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("2026-02-18")).toBeTruthy();
  });
  it("shows plain text from a service as text", () => {
    show("call_plugin_tool", { content: [{ type: "text", text: "Created issue ASH-12" }] });
    expect(screen.getByText("Created issue ASH-12")).toBeTruthy();
  });
});

describe("generic fallback", () => {
  it("lays out unfamiliar results as readable fields and drops bookkeeping", () => {
    show("future_tool", {
      kind: "x", invocationId: "abc", truncated: false, effectsApplied: false,
      total: 1200, enabled: true, labels: ["a", "b"], owner: { name: "Ada", role: "admin" }, missing: null, empty: [], blank: " ",
      hint: "Try a narrower query.", nextOffset: 50,
    });
    expect(screen.getByText("Try a narrower query.")).toBeTruthy();
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("More is available from position 50.")).toBeTruthy();
    for (const hidden of ["invocationId", "Effects applied", "Missing", "Empty", "Blank", "Kind"])
      expect(document.body.textContent).not.toContain(hidden);
  });
  it("does not choke on odd shapes", () => {
    for (const output of [[1, 2, 3], "plain text", 42, [{ a: 1 }, "x"], { deep: { a: { b: { c: { d: 1 } } } } }, { list: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `n${i}` })) }]) {
      show("future_tool", output);
      cleanup();
    }
  });
  it("shows a failed command's hint prominently", () => {
    show(
      "run_command",
      { exitCode: 1, stdout: "", stderr: "FileNotFoundError: report.csv", hint: "report.csv is in the workspace but was not listed in inputPaths." },
      { command: "python a.py" },
    );
    const hint = screen.getByText(/was not listed in inputPaths/);
    expect(hint.closest("p")?.className).toContain("bg-warning-muted");
    expect(screen.getByText("Exited with code 1")).toBeTruthy();
  });
  it("keeps a member's own inputs complete, including a field called kind", () => {
    render(<GenericResult inputs output={{ kind: "weekly", hint: "keep me", apiKey: "sk-secret", schemaHash: "zz" }} />);
    expect(screen.getByText("weekly")).toBeTruthy();
    expect(screen.getByText("keep me")).toBeTruthy();
    expect(screen.getByText("[redacted]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-secret");
    expect(document.body.textContent).not.toContain("zz");
  });
});
