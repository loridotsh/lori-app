import { describe, expect, it } from "vitest";
import fixture from "../../../../../../../packages/contracts/fixtures/artifact-fixture.json";
import conformance from "../../../../../../../packages/contracts/fixtures/artifact-conformance.json";
import studio from "../../../../../../../packages/contracts/fixtures/studio-fixture.json";
import studioConformance from "../../../../../../../packages/contracts/fixtures/studio-conformance.json";
import { parseVisual, visualText } from "@lori-enterprise/contracts";

function mutate(base: unknown, path: (string | number)[], value: unknown) {
  const source = structuredClone(base) as Record<string | number, unknown>;
  let parent = source;
  for (const key of path.slice(0, -1)) parent = parent[key] as typeof source;
  parent[path.at(-1)!] = value;
  return source;
}

describe("studio artifacts", () => {
  it("accepts slide decks, reports, and quizzes with hints and per-option rationales", () => {
    expect(parseVisual(studio)?.blocks.map(block => block.type)).toEqual(["slides", "report", "quiz"]);
  });
  it.each(studioConformance)("rejects $name", ({ path, value }) => {
    expect(parseVisual(mutate(studio, path, value))).toBeNull();
  });
  it("copies every slide, chart value, report section, rationale and hint as text", () => {
    const text = visualText(parseVisual(studio)!);
    for (const expected of ["Slide 1: Quarterly business review · Growth held while costs fell", "$4.2M — Revenue (+18% quarter on quarter)", "Jul\t1.2", "• Ship self-serve onboarding", "Notes: Open with the headline", "Executive summary", "2) 2.1% — Churn fell to 2.1% by September.", "Hint: It improved during the quarter."]) expect(text).toContain(expected);
  });
});

describe("artifact contract", () => {
  it("accepts the expanded catalog, grounded source notes, cycles in diagrams, and out-of-order mindmap nodes", () => {
    expect(parseVisual(fixture)?.blocks.map(block => block.type)).toEqual(["diagram", "mindmap", "timeline", "quiz", "flashcards"]);
    const reordered = structuredClone(fixture);
    reordered.blocks[1]!.nodes!.reverse();
    expect(parseVisual(reordered)).not.toBeNull();
  });
  it.each(conformance)("rejects $name", ({ path, value }) => {
    const source = structuredClone(fixture) as unknown as Record<string | number, unknown>;
    let parent = source;
    for (const key of path.slice(0, -1)) parent = parent[key] as typeof source;
    parent[path.at(-1)!] = value;
    expect(parseVisual(source)).toBeNull();
  });
  it("copies graph relationships, source notes, chronology, and complete answer keys", () => {
    const text = visualText(parseVisual(fixture)!);
    for (const expected of ["review → synthesis: Refine", "evidence → sources", "Day 2: Build understanding", "includes answer key", "Answer: 1) An original source", "What is a primary source?", "research.md · revision 3"]) expect(text).toContain(expected);
  });
});
