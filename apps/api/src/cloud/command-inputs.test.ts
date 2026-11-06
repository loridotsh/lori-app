import { describe, expect, it } from "vitest";
import { mentionedInputs, missingFileHint, readOnlyPathHint } from "./command-inputs.js";

const files = [
  { path: "q3-review.docx", sizeBytes: 100 },
  { path: "q3-sales.xlsx", sizeBytes: 200 },
  { path: "reports/summary.md", sizeBytes: 50 },
  { path: "a.md", sizeBytes: 10 },
  { path: ".trash/old.docx", sizeBytes: 10 },
];

describe("mentionedInputs", () => {
  it("stages a workspace file a command opens, however it is quoted", () => {
    for (const command of [
      "python - <<'PY'\nfrom docx import Document\nd = Document('q3-review.docx')\nPY",
      'python -c "open(\\"q3-review.docx\\")"',
      "cat ./q3-review.docx",
      "libreoffice --convert-to pdf q3-review.docx",
    ])
      expect(mentionedInputs(command, files, [])).toEqual(["q3-review.docx"]);
  });

  it("finds several files and paths inside folders", () => {
    expect(mentionedInputs("cp reports/summary.md q3-sales.xlsx out/", files, []).sort()).toEqual(["q3-sales.xlsx", "reports/summary.md"]);
  });

  it("does not add what is already declared", () => {
    expect(mentionedInputs("open('q3-review.docx')", files, ["q3-review.docx"])).toEqual([]);
  });

  it("never mistakes part of a longer name or path for a file", () => {
    for (const command of ["cat old-q3-review.docx", "cat q3-review.docx.bak", "cat q3-review.docx2", "cat data.md", "cat docs/a.md", "cat my_a.md", "echo a.mdx"])
      expect(mentionedInputs(command, files, []), command).toEqual([]);
  });

  it("matches at the end of a sentence or line, and next to punctuation", () => {
    expect(mentionedInputs("print(open('a.md').read())", files, [])).toEqual(["a.md"]);
    expect(mentionedInputs("Convert a.md.", files, [])).toEqual(["a.md"]);
    expect(mentionedInputs("x=a.md\n", files, [])).toEqual(["a.md"]);
  });

  it("ignores Trash and honors the input count and size limits", () => {
    expect(mentionedInputs("cat .trash/old.docx", files, [])).toEqual([]);
    // Longest path first, so the choice is the same every time.
    expect(mentionedInputs("cat q3-review.docx q3-sales.xlsx", files, [], { maxInputs: 1, maxBytes: 1e9 })).toEqual(["q3-review.docx"]);
    expect(mentionedInputs("cat q3-review.docx q3-sales.xlsx", files, [], { maxInputs: 100, maxBytes: 150 })).toEqual(["q3-review.docx"]);
  });

  it("is safe with names full of regex characters", () => {
    const odd = [{ path: "Q3 (final) [v2]+.docx", sizeBytes: 1 }];
    expect(mentionedInputs("Document('Q3 (final) [v2]+.docx')", odd, [])).toEqual(["Q3 (final) [v2]+.docx"]);
    expect(mentionedInputs("Document('Q3 final v2.docx')", odd, [])).toEqual([]);
  });
});

describe("readOnlyPathHint", () => {
  it("explains a write outside the sandbox's writable places, from the shell or Python", () => {
    expect(readOnlyPathHint("mkdir: cannot create directory '/tmp/out': Read-only file system")).toContain("$TMPDIR");
    expect(readOnlyPathHint("OSError: [Errno 30] Read-only file system: '/tmp/out'")).toContain("relative path");
  });
  it("stays quiet about other failures", () => {
    expect(readOnlyPathHint("ValueError: bad layout")).toBeUndefined();
    expect(readOnlyPathHint("")).toBeUndefined();
  });
});

describe("missingFileHint", () => {
  const python = "docx.opc.exceptions.PackageNotFoundError: Package not found at 'q3-review.docx'";
  it("explains a file that exists but was not staged", () => {
    expect(missingFileHint(python, files, [])).toMatch(/"q3-review\.docx" is in this conversation but was not listed in inputPaths/);
    expect(missingFileHint("FileNotFoundError: [Errno 2] No such file or directory: './q3-sales.xlsx'", files, [])).toMatch(/q3-sales\.xlsx/);
  });
  it("explains a file that is not in the conversation at all", () => {
    expect(missingFileHint("FileNotFoundError: [Errno 2] No such file or directory: 'made-up.docx'", files, [])).toMatch(/not a file in this conversation.*after the member applies it/s);
  });
  it("says nothing when the file was staged, or the error is something else", () => {
    expect(missingFileHint(python, files, ["q3-review.docx"])).toBeUndefined();
    expect(missingFileHint("TypeError: boom", files, [])).toBeUndefined();
    expect(missingFileHint("", files, [])).toBeUndefined();
  });
  it("recognizes the usual shell and interpreter wordings", () => {
    expect(missingFileHint("cat: cannot open 'a.md': No such file or directory", files, [])).toMatch(/"a\.md"/);
    expect(missingFileHint("python: can't open file 'a.md': [Errno 2]", files, [])).toMatch(/"a\.md"/);
  });
});
