import { describe, expect, it } from "vitest";
import { isArtifactFile, MAX_ARTIFACT_FILE_BYTES, parseArtifactFile, artifactDisplayName, artifactLinkText, artifactTitlesFromTools } from "@lori-enterprise/contracts";
import fixture from "../../../../../../../packages/contracts/fixtures/artifact-fixture.json";
import cases from "../../../../../../../packages/contracts/fixtures/artifact-conformance.json";

describe("saved artifact admission", () => {
  it("round-trips every saved format, source notes, formatting and UTF-8 BOM", () => {
    expect(parseArtifactFile(`\uFEFF${JSON.stringify(fixture, null, 2)}`)).toEqual(fixture);
    expect(isArtifactFile("reports/Study.LORI.JSON")).toBe(true);
    expect(isArtifactFile("report.json")).toBe(false);
    expect(isArtifactFile("report.lori.json.js")).toBe(false);
  });
  it.each(cases)("rejects invalid saved artifact: $name", ({ path, value }) => {
    const copy = structuredClone(fixture);
    let parent: Record<string | number, unknown> = copy as unknown as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as typeof parent;
    parent[path.at(-1)!] = value;
    expect(parseArtifactFile(JSON.stringify(copy))).toBeNull();
  });
  it("rejects truncated, unknown, executable, canonical oversize and whitespace oversize content", () => {
    for (const value of ["{", "null", "[]", '{"version":99}', JSON.stringify({ ...fixture, script: "fetch('/api')" }), JSON.stringify({ ...fixture, summary: "x".repeat(50000) }), " ".repeat(MAX_ARTIFACT_FILE_BYTES) + JSON.stringify(fixture), "界".repeat(MAX_ARTIFACT_FILE_BYTES / 2)])
      expect(parseArtifactFile(value)).toBeNull();
  });
});


describe("artifact display titles", () => {
  const write = (status = "completed", title = "Cash Runway Calculator") => ({ name: "write_file", status, arguments: { path: "finance/runway.lori.json", content: JSON.stringify({ ...fixture, title }) } });
  it("uses saved titles and readable fallback names without altering ordinary filenames", () => {
    expect(artifactDisplayName("finance/runway.lori.json", "Cash Runway Calculator")).toBe("Cash Runway Calculator");
    expect(artifactDisplayName("finance/cash_runway-v2.LORI.JSON")).toBe("Cash runway v2");
    expect(artifactDisplayName("finance/.lori.json")).toBe("Untitled artifact");
    expect(artifactDisplayName("finance/report.pdf", "Other title")).toBe("report.pdf");
    expect(artifactLinkText("finance/runway.lori.json", "runway.lori.json", "Cash Runway Calculator")).toBe("Cash Runway Calculator");
    expect(artifactLinkText("finance/runway.lori.json", "Review the cash model", "Cash Runway Calculator")).toBeNull();
  });
  it("recovers titles only from validated successful built-in writes", () => {
    expect(artifactTitlesFromTools([write("pending"), write("failed"), { ...write(), name: "plugin_write_file" }]).size).toBe(0);
    expect(artifactTitlesFromTools([write(), write("failed", "Failed title")]).get("finance/runway.lori.json")).toBe("Cash Runway Calculator");
    expect(artifactTitlesFromTools([write(), write("completed", "New title")]).get("finance/runway.lori.json")).toBe("New title");
    expect(artifactTitlesFromTools([{ ...write(), arguments: { path: "runway.lori.json", content: '{"title":"Unvalidated title"}' } }]).size).toBe(0);
  });
  it("does not reuse a stale title after an edit whose complete contents are unavailable", () => {
    const edited = { name: "edit_file", status: "completed", arguments: { path: "finance/runway.lori.json", oldText: "Cash Runway Calculator", newText: "New title" } };
    expect(artifactTitlesFromTools([write(), edited]).size).toBe(0);
  });
});
