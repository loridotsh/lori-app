import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVisual, visualText, calculate, MAX_VISUAL_BYTES, cloudVisualToolParameters } from "@lori-enterprise/contracts";
import { getCloudTools, modelOutput, normalizeCloudCall, invocation } from "./tools.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../packages/contracts/fixtures/${name}.json`, import.meta.url), "utf8"));
const visual = fixture("fixtures");
const simulation = fixture("simulation-fixture");
const artifacts = fixture("artifact-fixture");
type Case = { name: string; path: (string | number)[]; value: unknown };
function replaced(source: unknown, path: (string | number)[], value: unknown) {
  const copy: unknown = structuredClone(source);
  let target = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[path.at(-1)!] = value;
  return copy;
}

describe("Cloud visual admission shared with the browser", () => {
  it("admits every new artifact through the same server boundary and persists a compact presentation receipt", () => {
    const parsed = parseVisual(artifacts)!;
    expect(parsed.blocks.map(block => block.type)).toEqual(["diagram", "mindmap", "timeline", "quiz", "flashcards"]);
    const receipt = modelOutput({ kind: "cloud_visual", presented: true, visual: parsed }, "artifact-id", 8192, "present_visual");
    expect(receipt).toMatchObject({ kind: "cloud_visual", presented: true, title: parsed.title, invocationId: "artifact-id" });
    expect(receipt).not.toHaveProperty("visual");
  });
  it.each(fixture("artifact-conformance") as Case[])("rejects artifact $name", ({ path, value }) => expect(parseVisual(replaced(artifacts, path, value))).toBeNull());
  it("admits slide decks, reports and quizzes with hints and rationales through the same boundary", () => {
    const studio = fixture("studio-fixture");
    const parsed = parseVisual(studio)!;
    expect(parsed.blocks.map(block => block.type)).toEqual(["slides", "report", "quiz"]);
    expect(visualText(parsed)).toContain("Slide 3: Revenue grew every month");
    expect(JSON.stringify(cloudVisualToolParameters)).toContain("Slides <=20");
  });
  it.each(fixture("studio-conformance") as Case[])("rejects studio $name", ({ path, value }) => expect(parseVisual(replaced(fixture("studio-fixture"), path, value))).toBeNull());
  it("accepts all six bounded component types", () => {
    expect(parseVisual(visual)?.blocks.map(b => b.type)).toEqual(["metrics", "chart", "calculator", "table", "steps"]);
    expect(parseVisual(simulation)?.blocks[0]?.type).toBe("simulation");
  });
  it.each(fixture("conformance") as Case[])("rejects $name", ({ path, value }) => expect(parseVisual(replaced(visual, path, value))).toBeNull());
  it.each(fixture("simulation-conformance") as Case[])("rejects simulation $name", ({ path, value }) => expect(parseVisual(replaced(simulation, path, value))).toBeNull());
  it("rejects aggregate byte excess, cycles, future versions, nonfinite data and invisible labels", () => {
    expect(parseVisual(replaced(visual, ["blocks", 3, "rows"], Array.from({ length: 100 }, () => ["x".repeat(290), 500, "y".repeat(290)])))).toBeNull();
    expect(parseVisual(replaced(visual, ["summary"], "x".repeat(MAX_VISUAL_BYTES)))).toBeNull();
    expect(parseVisual(replaced(visual, ["version"], 99))).toBeNull();
    expect(parseVisual(replaced(visual, ["blocks", 1, "series", 0, "values", 0], NaN))).toBeNull();
    expect(parseVisual(replaced(visual, ["blocks", 1, "labels", 0], "  "))).toBeNull();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(parseVisual(cyclic)).toBeNull();
    expect(parseVisual(undefined)).toBeNull();
  });
  it("rejects actions, executable expressions and fields rather than silently removing them", () => {
    const unsafe = { ...(visual as object), onClick: "fetch('/api/delete')" };
    const call = normalizeCloudCall({ id: "c", name: "present_visual", arguments: unsafe });
    expect(call.arguments).toHaveProperty("onClick");
    expect(parseVisual(call.arguments)).toBeNull();
    expect(parseVisual(replaced(visual, ["blocks", 2, "outputs", 0, "expression"], "globalThis.fetch('/api')"))).toBeNull();
  });
  it("has a compact model schema available even without a document sandbox", () => {
    expect(JSON.stringify(cloudVisualToolParameters).length).toBeLessThan(6000);
    for (const isolated of [false, true]) expect(getCloudTools(isolated).find(t => t.name === "present_visual")?.parameters).toEqual(cloudVisualToolParameters);
  });
  it("keeps complete visuals durable while model previews and snapshots stay compact", () => {
    const full = { kind: "cloud_visual", presented: true, visual };
    const model = modelOutput(full, "invocation", 8192, "present_visual");
    expect(model).toMatchObject({ kind: "cloud_visual", presented: true, title: parseVisual(visual)!.title, invocationId: "invocation" });
    expect(model).not.toHaveProperty("visual");
    // A plugin can return arbitrary JSON, including the same discriminator.
    // It must retain ordinary tool-output handling rather than impersonating this tool.
    const small = { kind: "cloud_visual", visual: { version: 1, title: "A", summary: "B", blocks: [{ type: "metrics", title: "C", items: [{ label: "D", value: "E" }] }] } };
    expect(modelOutput(small, "plugin-invocation")).toEqual(small);
    const item = invocation({ id: "i", run_id: "r", round_id: "round", call_id: "call", name: "present_visual", arguments: visual,
      status: "completed", action_hash: "hash", text_offset: 12, output: model, model_output: model, created_at: new Date(), updated_at: new Date() });
    expect(parseVisual(item.arguments)).toEqual(visual);
    expect(item.output).toEqual(model);
    const text = visualText(parseVisual(visual)!);
    expect(text).toContain("April\t120\t120");
    expect(text).toContain("Monthly revenue: 96000 INR");
    expect(text).toContain("default inputs");
  });
});

describe("Cloud arithmetic without executable code", () => {
  const values = new Map([["price", 18], ["cost", 7], ["quantity", 4]]);
  it.each(fixture("arithmetic-cases") as { expression: string; expected: number | null }[])("evaluates $expression", ({ expression, expected }) => {
    const result = calculate(expression, values);
    if (expected === null) expect(result).toBeNull(); else expect(result).toBeCloseTo(expected, 8);
  });
  it("bounds finite intermediate and final results as well as model literals", () => {
    const values = new Map([["x", 10000000]]);
    expect(calculate("x^2", values)).toBeNull();
    expect(calculate("(x^2)/100", values)).toBeNull();
    expect(calculate("tan(1.5707963267948966)", values)).toBeNull();
    expect(calculate("x*100000", values)).toBe(1e12);
    expect(parseVisual(replaced(visual, ["blocks", 2, "outputs", 0, "expression"], "10000000^2"))).toBeNull();
  });
  it("rejects unbounded, undefined and executable calculations", () => {
    for (const expression of ["fetch('https://example.com')", "constructor", "1/0", "sqrt(-1)", "(".repeat(40) + "1" + ")".repeat(40)]) expect(calculate(expression, values)).toBeNull();
  });
});
