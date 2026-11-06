import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fingerprint } from "./security.js";
import {
  argumentIssues,
  cloudToolDefinitions,
  normalizeCloudCall,
  type ToolCall,
} from "./tools.js";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "call_1",
  name,
  arguments: args,
});
const normalized = (name: string, args: Record<string, unknown>) =>
  normalizeCloudCall(call(name, args)).arguments;
const schemaFor = (name: string) =>
  z.fromJSONSchema(
    cloudToolDefinitions.find((tool) => tool.name === name)!.parameters as never,
  );

describe("tool argument repair", () => {
  it("forgives stray spaces in a skill id and reference, repeatably", () => {
    const repaired = normalized("load_skill", { id: " research ", reference: " SKILL.md" });
    expect(repaired).toEqual({ id: "research", reference: "SKILL.md" });
    expect(normalized("load_skill", repaired)).toEqual(repaired);
  });
  it("accepts numbers and booleans a model sent as text", () => {
    expect(normalized("list_files", { limit: "25", offset: " 5 " })).toEqual({
      limit: 25,
      offset: 5,
    });
    expect(
      normalized("validate_document", { path: "a.docx", visualReview: "TRUE" }),
    ).toEqual({ path: "a.docx", visualReview: true });
  });

  it("clamps paging and time budgets instead of failing the call", () => {
    expect(normalized("list_files", { limit: 5000 })).toMatchObject({ limit: 100 });
    expect(
      normalized("run_command", { command: "ls", timeoutSeconds: 9000 }),
    ).toMatchObject({ timeoutSeconds: 600 });
    expect(normalized("list_files", { limit: 0 })).toMatchObject({ limit: 1 });
  });

  it("leaves other out-of-range numbers for the schema to refuse", () => {
    expect(normalized("read_file", { path: "a.txt", startLine: 0 })).toMatchObject({
      startLine: 0,
    });
  });

  it("wraps a single value and unquotes JSON lists for array parameters", () => {
    expect(
      normalized("run_command", { command: "python a.py", inputPaths: "a.py" }),
    ).toMatchObject({ inputPaths: ["a.py"] });
    expect(
      normalized("run_command", {
        command: "python a.py",
        inputPaths: '["a.py","b.py"]',
      }),
    ).toMatchObject({ inputPaths: ["a.py", "b.py"] });
    expect(
      normalized("run_command", { command: "ls", inputPaths: "" }),
    ).toMatchObject({ inputPaths: [] });
  });

  it("drops null/blank optionals and fields a closed schema never defined", () => {
    expect(
      normalized("read_file", {
        path: "a.txt",
        offset: null,
        description: "why I am reading this",
      }),
    ).toEqual({ path: "a.txt" });
    expect(
      normalized("inspect_document", { path: "a.xlsx", sheet: "  " }),
    ).toEqual({ path: "a.xlsx" });
  });

  it("understands snake_case and common names for the parameter a model meant", () => {
    expect(normalized("read_file", { file_path: "a.txt", start_line: "3" })).toEqual({
      path: "a.txt",
      startLine: 3,
    });
    expect(normalized("write_file", { filename: "a.md", text: "hi" })).toEqual({
      path: "a.md",
      content: "hi",
    });
    expect(
      normalized("edit_file", { path: "a", old_string: "x", new_string: "y", expected_hash: "a".repeat(64) }),
    ).toEqual({ path: "a", oldText: "x", newText: "y", expectedHash: "a".repeat(64) });
    expect(
      normalized("render_document", { path: "a.pdf", output_directory: "pages" }),
    ).toEqual({ path: "a.pdf", outputDirectory: "pages" });
  });

  it("keeps the parameter the model named correctly over a lookalike", () => {
    expect(normalized("read_file", { path: "right.txt", file_path: "wrong.txt" })).toEqual({
      path: "right.txt",
    });
  });

  it("does not guess when a field matches nothing", () => {
    expect(normalized("read_file", { document: "a.txt" })).toEqual({});
  });

  it("never invents or removes a required value", () => {
    expect(normalized("read_file", { limit: "10" })).toEqual({ limit: 10 });
    expect(normalized("read_file", { path: null })).toEqual({ path: null });
  });

  it("is idempotent so receipts, native continuations and requests agree", () => {
    const messy = {
      path: "a.txt",
      limit: "99999",
      offset: null,
      extra: { nested: true },
    };
    const once = normalizeCloudCall(call("read_file", messy));
    const twice = normalizeCloudCall(once);
    expect(fingerprint(twice)).toBe(fingerprint(once));
  });

  it("lets the repaired call pass the real schema", () => {
    const repaired = normalized("list_files", { path: "", limit: "50", note: 1 });
    expect(schemaFor("list_files").safeParse(repaired).success).toBe(true);
  });

  it("leaves tools without a schema, and plugin payloads, untouched", () => {
    expect(normalized("not_a_tool", { limit: "5", x: null })).toEqual({
      limit: "5",
      x: null,
    });
  });
});

describe("tool argument errors", () => {
  const parse = (name: string, args: Record<string, unknown>) =>
    schemaFor(name).safeParse(normalized(name, args));

  it("names the offending parameter without echoing its value", () => {
    const result = parse("read_file", { path: 42, startLine: "secret-token" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = argumentIssues(result.error);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path === "startLine")).toBe(true);
    expect(JSON.stringify(issues)).not.toContain("secret-token");
  });

  it("explains a missing required parameter", () => {
    const result = parse("read_file", {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(argumentIssues(result.error)[0]!.path).toBe("path");
  });

  it("bounds how much detail it returns", () => {
    const result = z
      .object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, z.string()])))
      .safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(argumentIssues(result.error)).toHaveLength(8);
  });
});
