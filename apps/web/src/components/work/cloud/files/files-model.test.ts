import { describe, expect, it } from "vitest";
import type { CloudFile, CloudToolInvocation } from "@lori-enterprise/contracts";
import { changedFilePaths } from "./changed-paths";
import { parseDelimited } from "./csv";
import { buildRows, folderPaths, formatModified } from "./file-tree";
import { imageType, previewMode } from "./file-preview";

const file = (path: string, extra: Partial<CloudFile> = {}): CloudFile => ({
  id: path,
  conversationId: "chat",
  path,
  mimeType: "text/plain",
  sizeBytes: 10,
  sha256: "h",
  version: 1,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
  ...extra,
});
const names = (rows: ReturnType<typeof buildRows>) =>
  rows.map((row) => (row.type === "folder" ? `${row.name}/` : row.name));

describe("file tree", () => {
  const files = [
    file("notes.md"),
    file("reports/q3/summary.md"),
    file("reports/q3/chart.png"),
    file("reports/overview.md"),
    file("Trash/abc/old.txt"),
    file("file10.txt"),
    file("file2.txt"),
  ];
  it("lists folders first, files sorted naturally, and Trash last", () => {
    expect(names(buildRows(files))).toEqual([
      "reports/", "q3/", "chart.png", "summary.md", "overview.md",
      "Trash/", "abc/", "old.txt",
      "file2.txt", "file10.txt", "notes.md",
    ]);
  });
  it("keeps Trash at the end of the folders and indents by depth", () => {
    const rows = buildRows(files);
    const folders = rows.filter((row) => row.type === "folder").map((row) => row.name);
    expect(folders).toEqual(["reports", "q3", "Trash", "abc"]);
    const q3 = rows.find((row) => row.type === "folder" && row.path === "reports/q3")!;
    expect(q3.depth).toBe(1);
    expect(rows.find((row) => row.type === "file" && row.name === "chart.png")!.depth).toBe(2);
  });
  it("counts the files below each folder", () => {
    const rows = buildRows(files);
    const count = (path: string) => (rows.find((row) => row.type === "folder" && row.path === path) as { count: number }).count;
    expect(count("reports")).toBe(3);
    expect(count("reports/q3")).toBe(2);
  });
  it("hides the rows of collapsed folders but still shows the folder", () => {
    const rows = buildRows(files, { collapsed: new Set(["reports", "Trash"]) });
    expect(names(rows)).toEqual(["reports/", "Trash/", "file2.txt", "file10.txt", "notes.md"]);
    expect(rows.find((row) => row.type === "folder" && row.name === "reports")).toMatchObject({ open: false, count: 3 });
  });
  it("shows every match with its folders open, whatever is collapsed", () => {
    const rows = buildRows(files, { query: "OLD", collapsed: new Set(["Trash", "Trash/abc"]) });
    expect(names(rows)).toEqual(["Trash/", "abc/", "old.txt"]);
    expect(buildRows(files, { query: "nothing here" })).toEqual([]);
  });
  it("lists every folder that holds files", () => {
    expect(folderPaths(files).sort()).toEqual(["Trash", "Trash/abc", "reports", "reports/q3"]);
  });
});

describe("formatModified", () => {
  const now = new Date(2026, 9, 12, 15, 0);
  it("shows a time for today, a date for earlier, and a year for other years", () => {
    expect(formatModified(new Date(2026, 9, 12, 9, 5).toISOString(), now)).toMatch(/9:05/);
    expect(formatModified(new Date(2026, 8, 3, 9, 5).toISOString(), now)).toMatch(/Sep.*3|3.*Sep/);
    expect(formatModified(new Date(2025, 8, 3, 9, 5).toISOString(), now)).toContain("2025");
  });
  it("returns nothing for a date it cannot read", () => {
    expect(formatModified("not a date", now)).toBe("");
  });
});

describe("delimited text", () => {
  it("parses quotes, escaped quotes, embedded newlines and CRLF", () => {
    const table = parseDelimited('name,note\r\n"Smith, J","said ""hi"""\r\nLee,"two\nlines"\r\n');
    expect(table.rows).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"'],
      ["Lee", "two\nlines"],
    ]);
    expect(table.clipped).toBe(false);
  });
  it("supports tabs, a BOM, a missing final newline and blank cells", () => {
    expect(parseDelimited("﻿a\tb\t\n1\t\t3", "\t").rows).toEqual([["a", "b", ""], ["1", "", "3"]]);
  });
  it("stops at the row and column limits and says so", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `${i},${i},${i}`).join("\n");
    expect(parseDelimited(rows, ",", 4, 2)).toEqual({
      rows: [["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]],
      clipped: true,
    });
  });
  it("returns no rows for empty text", () => {
    expect(parseDelimited("").rows).toEqual([]);
  });
});

describe("how a file is previewed", () => {
  it("edits text and code, tables CSV, and previews images and PDFs", () => {
    expect(previewMode({ path: "a.md", mimeType: "text/markdown" })).toBe("text");
    expect(previewMode({ path: "a.ts", mimeType: "" })).toBe("text");
    expect(previewMode({ path: "Makefile", mimeType: "application/octet-stream" })).toBe("text");
    expect(previewMode({ path: "data.csv", mimeType: "text/csv" })).toBe("text");
    expect(previewMode({ path: "pic.PNG", mimeType: "image/png" })).toBe("image");
    expect(previewMode({ path: "x.pdf", mimeType: "application/pdf" })).toBe("pdf");
  });
  it("offers a download card for formats the browser cannot show as text", () => {
    for (const path of ["a.docx", "a.pptx", "a.doc", "a.xls", "a.ppt", "a.odt", "a.ods", "a.odp"])
      expect(previewMode({ path, mimeType: "" })).toBe("document");
    // Workbooks open as a live sheet.
    expect(previewMode({ path: "a.xlsx", mimeType: "" })).toBe("spreadsheet");
    expect(previewMode({ path: "DIR/Budget.XLSX", mimeType: "" })).toBe("spreadsheet");
    for (const path of ["z.zip", "photo.heic"])
      expect(previewMode({ path, mimeType: "" })).toBe("binary");
  });
  it("only shows images the browser can render", () => {
    expect(imageType("a.svg")).toBe("image/svg+xml");
    expect(imageType("a.heic")).toBeNull();
  });
});

describe("files from a response", () => {
  const call = (name: string, status: CloudToolInvocation["status"], output?: unknown): CloudToolInvocation => ({
    id: `${name}-${Math.random()}`, runId: "r", roundId: "x", callId: "c", name, arguments: {},
    actionHash: "h", status, textOffset: 0, createdAt: "", updatedAt: "",
    ...(output === undefined ? {} : { output }),
  });
  it("lists created, edited and moved files once each, in order", () => {
    expect(
      changedFilePaths([
        call("write_file", "completed", { file: { path: "a.md" } }),
        call("edit_file", "completed", { file: { path: "b.md" } }),
        call("edit_file", "completed", { file: { path: "a.md" } }),
        call("manage_files", "completed", { moved: true, path: "archive/c.md" }),
        call("manage_files", "completed", { file: { path: "copy.md" } }),
      ]),
    ).toEqual(["a.md", "b.md", "archive/c.md", "copy.md"]);
  });
  it("includes files that a command or document tool generated once they were applied", () => {
    expect(
      changedFilePaths([
        call("run_command", "completed", { result: { exitCode: 0 }, changedFiles: [{ path: "out/report.pdf" }, { path: "out/data.csv" }] }),
        call("convert_document", "pendingApproval", { result: {}, changedFiles: [{ path: "not-applied.pdf" }] }),
      ]),
    ).toEqual(["out/report.pdf", "out/data.csv"]);
  });
  it("ignores declined, failed and unfinished calls, reads, and files moved to Trash", () => {
    expect(
      changedFilePaths([
        call("write_file", "denied", { error: "declined" }),
        call("write_file", "failed", { file: { path: "x.md" } }),
        call("write_file", "pendingApproval"),
        call("read_file", "completed", { file: { path: "r.md" } }),
        call("manage_files", "completed", { trashed: true, path: "Trash/g/old.md" }),
      ]),
    ).toEqual([]);
  });
});
