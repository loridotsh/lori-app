import { describe, expect, it } from "vitest";
import {
  describeRejections,
  fileKind,
  MAX_BATCH_FILES,
  MAX_UPLOAD_BYTES,
  pastedName,
  prepareUploads,
  uploadName,
} from "./file-kinds";
import {
  applyMention,
  filterMentions,
  findMentionQuery,
  highlightMentions,
  mentionText,
  type MentionOption,
} from "./mentions";

const file = (name: string, size = 10, type = "") => {
  const value = new File(["x"], name, { type });
  Object.defineProperty(value, "size", { value: size });
  return value;
};

describe("fileKind", () => {
  it("classifies by extension, then by media type", () => {
    expect(fileKind("report.PDF")).toBe("pdf");
    expect(fileKind("a/b/data.csv")).toBe("spreadsheet");
    expect(fileKind("deck.pptx")).toBe("presentation");
    expect(fileKind("src/app.tsx")).toBe("code");
    expect(fileKind("notes.md")).toBe("text");
    expect(fileKind("photo", "image/heic")).toBe("image");
    expect(fileKind("README")).toBe("other");
    expect(fileKind(".env")).toBe("other");
    // Own-property lookup only.
    expect(fileKind("x.__proto__")).toBe("other");
    expect(fileKind("x.constructor")).toBe("other");
  });
});

describe("uploadName", () => {
  it("removes separators and control characters and keeps a bounded name", () => {
    // Separators become underscores, so no name can climb out of the workspace.
    expect(uploadName("..\\secret/evil.txt")).toBe("_secret_evil.txt");
    expect(uploadName("a\u0000b\u001fc.txt")).toBe("a_b_c.txt");
    expect(uploadName("   ")).toBe("file");
    expect(uploadName("...")).toBe("file");
    const long = `${"x".repeat(300)}.xlsx`;
    expect(uploadName(long)).toHaveLength(200);
    expect(uploadName(long).endsWith(".xlsx")).toBe(true);
  });
  it("names pasted images", () => {
    const now = new Date(2026, 9, 12, 9, 5, 7);
    expect(pastedName({ name: "image.png", type: "image/png" }, now)).toBe("pasted-image-20261012-090507.png");
    expect(pastedName({ name: "", type: "image/jpeg" }, now)).toBe("pasted-image-20261012-090507.jpg");
    expect(pastedName({ name: "diagram.png", type: "image/png" }, now)).toBe("diagram.png");
  });
});

describe("prepareUploads", () => {
  it("accepts good files and explains each rejection", () => {
    const { accepted, rejected } = prepareUploads([
      file("a.txt", 5, "text/plain"),
      file("empty.txt", 0),
      file("huge.zip", MAX_UPLOAD_BYTES + 1),
      file("b.png", 20, "image/png"),
    ]);
    expect(accepted.map((item) => item.name)).toEqual(["a.txt", "b.png"]);
    expect(accepted[0]!.mimeType).toBe("text/plain");
    expect(rejected).toEqual([
      { name: "empty.txt", reason: "is empty" },
      { name: "huge.zip", reason: "is larger than 20 MB" },
    ]);
    expect(describeRejections(rejected)).toBe("empty.txt is empty. huge.zip is larger than 20 MB.");
  });
  it("keeps both files when names collide, including with existing files", () => {
    const { accepted } = prepareUploads([file("a.txt"), file("A.txt"), file("a.txt")], { existing: ["A.TXT"] });
    expect(accepted.map((item) => item.name)).toEqual(["a (2).txt", "A (3).txt", "a (4).txt"]);
  });
  it("caps one batch and omits an invalid media type", () => {
    const many = Array.from({ length: MAX_BATCH_FILES + 3 }, (_, i) => file(`f${i}.txt`));
    const { accepted, rejected } = prepareUploads(many);
    expect(accepted).toHaveLength(MAX_BATCH_FILES);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]!.reason).toMatch(/at once/);
    expect(prepareUploads([file("x.bin", 5, "not a type")]).accepted[0]).not.toHaveProperty("mimeType");
  });
  it("names pasted images and survives an unnamed file", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const { accepted } = prepareUploads([file("image.png", 5, "image/png")], { paste: true, now });
    expect(accepted[0]!.name).toBe("pasted-image-20260102-030405.png");
    const unnamed = prepareUploads([file("", 5)]);
    expect(unnamed.accepted[0]!.name).toBe("file");
  });
  it("summarizes many rejections without flooding the message", () => {
    const rejected = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, reason: "is empty" }));
    expect(describeRejections(rejected)).toBe("f0 is empty. f1 is empty. f2 is empty, and 3 more.");
    expect(describeRejections([])).toBe("");
  });
});

const options: MentionOption[] = [
  { id: "f1", kind: "file", label: "notes/plan.md" },
  { id: "f2", kind: "file", label: "budget.xlsx" },
  { id: "f3", kind: "file", label: "my notes.txt" },
  { id: "p1", kind: "plugin", label: "GitHub", pluginId: "github" },
  { id: "s1", kind: "skill", label: "Documents" },
];

describe("findMentionQuery", () => {
  it("detects a mention being typed and ignores emails", () => {
    expect(findMentionQuery("see @pl", 7)).toEqual({ start: 4, end: 7, query: "pl" });
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findMentionQuery("mail me at a@b.com", 18)).toBeNull();
    expect(findMentionQuery("(@git", 5)).toEqual({ start: 1, end: 5, query: "git" });
    expect(findMentionQuery('read @"my no', 12)).toEqual({ start: 5, end: 12, query: "my no" });
    expect(findMentionQuery("hello", 5)).toBeNull();
    expect(findMentionQuery("hi @x ", 6)).toBeNull();
    expect(findMentionQuery("a", 99)).toBeNull();
  });
  it("only looks at the text before the caret", () => {
    expect(findMentionQuery("see @plan and more", 9)).toEqual({ start: 4, end: 9, query: "plan" });
  });
});

describe("filterMentions", () => {
  it("ranks exact and prefix matches first", () => {
    expect(filterMentions(options, "plan").map((o) => o.id)).toEqual(["f1"]);
    expect(filterMentions(options, "git").map((o) => o.id)).toEqual(["p1"]);
    // A path that starts with the query outranks one that merely contains it.
    expect(filterMentions(options, "notes").map((o) => o.id)).toEqual(["f1", "f3"]);
    expect(filterMentions(options, "zzz")).toEqual([]);
  });
  it("groups files, plugins and skills when nothing is typed, within a limit", () => {
    expect(filterMentions(options, "").map((o) => o.kind)).toEqual(["file", "file", "file", "plugin", "skill"]);
    expect(filterMentions(options, "", 2)).toHaveLength(2);
  });
});

describe("applyMention", () => {
  it("replaces the typed query and keeps the rest of the text", () => {
    const query = findMentionQuery("see @pl", 7)!;
    expect(applyMention("see @pl", query, options[0]!)).toEqual({ text: "see @notes/plan.md ", caret: 19 });
    const middle = findMentionQuery("a @g later", 4)!;
    expect(applyMention("a @g later", middle, options[3]!).text).toBe("a @GitHub later");
  });
  it("quotes names with spaces so they stay one token", () => {
    expect(mentionText(options[2]!)).toBe('@"my notes.txt"');
    expect(mentionText(options[3]!)).toBe("@GitHub");
  });
});

describe("highlightMentions", () => {
  const known = ["notes/plan.md", "GitHub", "my notes.txt"];
  it("marks only tokens that match something real", () => {
    expect(highlightMentions("Summarize @notes/plan.md, then @GitHub.", known)).toEqual([
      { text: "Summarize ", mention: false },
      { text: "@notes/plan.md", mention: true },
      { text: ", then ", mention: false },
      { text: "@GitHub", mention: true },
      { text: ".", mention: false },
    ]);
    expect(highlightMentions('Open @"my notes.txt" now', known).map((s) => s.mention)).toEqual([false, true, false]);
    expect(highlightMentions("email me@example.com or @unknown", known)).toEqual([
      { text: "email me@example.com or @unknown", mention: false },
    ]);
    expect(highlightMentions("no mentions", known)).toEqual([{ text: "no mentions", mention: false }]);
    expect(highlightMentions("@GitHub", [])).toEqual([{ text: "@GitHub", mention: false }]);
  });
  it("is case-insensitive and never loses text", () => {
    const text = "x @github y @GITHUB z";
    expect(highlightMentions(text, known).map((s) => s.text).join("")).toBe(text);
  });
});
