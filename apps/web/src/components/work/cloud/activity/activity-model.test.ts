import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { WrenchIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { buildFlow } from "./activity-flow";
import { diffStats, lineDiff } from "./diff";
import {
  describeTool,
  formatDuration,
  statusIcon,
  summarizeActivity,
} from "./tool-presentation";

let counter = 0;
function call(
  name: string,
  args: Record<string, unknown> = {},
  textOffset?: number | null,
  createdAt = `2026-10-12T00:00:${String(10 + counter++).padStart(2, "0")}Z`,
): CloudToolInvocation {
  return {
    id: `inv-${counter}`,
    runId: "run",
    roundId: "round",
    callId: `c${counter}`,
    name,
    arguments: args,
    actionHash: "h",
    status: "completed",
    ...(textOffset !== undefined ? { textOffset } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

describe("buildFlow", () => {
  it("hides internal task bookkeeping while keeping saved receipts intact", () => {
    const invocations = [call("read_todos"),call("update_task_progress")];
    expect(buildFlow("Done",invocations)).toEqual([{type:"text",key:expect.any(String),text:"Done"}]);
    expect(invocations).toHaveLength(2);
  });
  it("coalesces successful todo snapshots and retains errors", () => {
    const first={...call("write_todos"),output:{todoList:{revision:1,todos:[{id:"a",content:"Inspect",status:"in_progress"}]}}};
    const last={...call("write_todos"),output:{todoList:{revision:2,todos:[{id:"a",content:"Inspect",status:"completed"}]}}};
    const failed={...call("write_todos"),status:"failed" as const,output:{error:"conflict"}};
    const flow=buildFlow("",[first,last,failed]);
    expect(flow.filter(part=>part.type==="todos")).toEqual([{type:"todos",key:`todos:${first.id}`,list:last.output.todoList}]);
    expect(flow.flatMap(part=>part.type==="tools"?part.invocations.map(item=>item.id):[])).toEqual([]);
    expect(flow).toContainEqual({type:"text",key:`task-status:${failed.id}`,text:"The task list update could not be confirmed."});
  });
  it("places each group of calls where it happened among the text", () => {
    const text = "I'll look first. Found it. All done.";
    const parts = buildFlow(text, [
      call("list_files", {}, "I'll look first.".length),
      call("read_file", { path: "a.md" }, "I'll look first. Found it.".length),
    ]);
    expect(parts.map((p) => p.type)).toEqual([
      "text",
      "tools",
      "text",
      "tools",
      "text",
    ]);
    expect(parts[0]).toMatchObject({ text: "I'll look first." });
    expect(parts[2]).toMatchObject({ text: "Found it." });
    expect(parts[4]).toMatchObject({ text: "All done." });
  });
  it("groups calls with only whitespace between them", () => {
    const parts = buildFlow("Working.\n\n", [
      call("read_file", {}, 8),
      call("read_file", {}, 10),
      call("search_text", {}, 10),
    ]);
    expect(parts.map((p) => p.type)).toEqual(["text", "tools"]);
    expect(parts[1]).toMatchObject({ invocations: expect.any(Array) });
    expect((parts[1] as { invocations: unknown[] }).invocations).toHaveLength(
      3,
    );
  });
  it("puts calls from before offsets existed first, and keeps text intact", () => {
    const parts = buildFlow("The answer.", [
      call("list_files", {}, null),
      call("read_file"),
    ]);
    expect(parts.map((p) => p.type)).toEqual(["tools", "text"]);
    expect((parts[0] as { invocations: unknown[] }).invocations).toHaveLength(
      2,
    );
  });
  it("lets an offset-less call follow the one before it", () => {
    const parts = buildFlow("Intro. Outro.", [
      call("a", {}, 6),
      call("b", {}, null),
    ]);
    expect(parts.map((p) => p.type)).toEqual(["text", "tools", "text"]);
    expect((parts[1] as { invocations: unknown[] }).invocations).toHaveLength(
      2,
    );
  });
  it("clamps wild offsets, never goes backwards and never splits a surrogate pair", () => {
    const text = "a😀b";
    const past = buildFlow(text, [call("x", {}, 999)]);
    expect(past.map((p) => p.type)).toEqual(["text", "tools"]);
    const split = buildFlow(text, [call("x", {}, 2)]); // inside the emoji
    expect(split[0]).toMatchObject({ text: "a😀" });
    const backwards = buildFlow("one two", [
      call("x", {}, 4),
      call("y", {}, 1),
    ]);
    expect(backwards.map((p) => p.type)).toEqual(["text", "tools", "text"]);
    expect(buildFlow(text, [call("x", {}, -5)]).map((p) => p.type)).toEqual([
      "tools",
      "text",
    ]);
    expect(
      buildFlow(text, [call("x", {}, Number.NaN)]).map((p) => p.type),
    ).toEqual(["tools", "text"]);
  });
  it("keeps visuals inline between tool disclosures with stable identities and Unicode offsets", () => {
    const read = call("read_file", {}, 3);
    const visual = call("present_visual", {}, 3);
    const write = call("write_file", {}, 3);
    const parts = buildFlow("😀 Intro", [read, visual, write]);
    expect(parts.map(p => p.type)).toEqual(["text", "tools", "visual", "tools", "text"]);
    expect(parts[2]).toMatchObject({ key: `visual:${visual.id}`, invocation: visual });
    const replay = buildFlow("😀 Intro. More", [read, { ...visual, output: { presented: true } }, write]);
    expect(replay[2]!.key).toBe(parts[2]!.key);
  });
  it("shows a repaired visual instead of obsolete failures and keeps successes and the latest failure", () => {
    const failed = { ...call("present_visual", { title: "Forecast" }, 0), status: "failed" as const };
    const repaired = call("present_visual", { title: "Forecast" }, 4);
    const other = { ...call("present_visual", { title: "Other" }, 4), status: "failed" as const };
    const parts = buildFlow("Intro. Done.", [failed, repaired, other]);
    const visuals = parts.filter(p => p.type === "visual");
    expect(visuals.map(p => p.invocation.id)).toEqual([repaired.id, other.id]);
    expect(parts.filter(p => p.type === "text").map(p => p.text).join("")).toBe("Intro. Done.");
    const laterFailure = { ...call("present_visual", { title: "Forecast" }, 4), status: "failed" as const };
    expect(buildFlow("", [failed, repaired, laterFailure]).filter(p => p.type === "visual").map(p => p.invocation.id)).toEqual([repaired.id, laterFailure.id]);
    const onlyFailures = buildFlow("", [failed, { ...repaired, status: "failed" }]).filter(p => p.type === "visual");
    expect(onlyFailures).toHaveLength(1);
    expect(onlyFailures[0]!.invocation.id).toBe(repaired.id);
    const otherRun = { ...repaired, runId: "different" };
    expect(buildFlow("", [failed, otherRun]).filter(p => p.type === "visual")).toHaveLength(2);
  });
  it("handles no text and no calls", () => {
    expect(buildFlow("", [])).toEqual([]);
    expect(buildFlow("   \n", [])).toEqual([]);
    expect(buildFlow("", [call("x", {}, 0)]).map((p) => p.type)).toEqual([
      "tools",
    ]);
    expect(buildFlow("Hello", []).map((p) => p.type)).toEqual(["text"]);
  });
  it("orders by time regardless of the order given", () => {
    const first = call("a", {}, 0, "2026-10-12T00:00:01Z");
    const second = call("b", {}, 0, "2026-10-12T00:00:02Z");
    const parts = buildFlow("", [second, first]);
    expect(
      (parts[0] as { invocations: CloudToolInvocation[] }).invocations.map(
        (c) => c.name,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("describeTool", () => {
  it("gives every real tool a readable action and subject", () => {
    expect(
      describeTool({ name: "read_file", arguments: { path: "notes/plan.md" } }),
    ).toMatchObject({
      past: "Read",
      subject: "notes/plan.md",
      kind: "read",
    });
    expect(
      describeTool({
        name: "run_command",
        arguments: { command: "python  \n report.py" },
      }),
    ).toMatchObject({
      past: "Ran",
      // A command is named by its first line; more lines are marked, not run together.
      subject: "python …",
      kind: "command",
    });
    expect(
      describeTool({
        name: "manage_files",
        arguments: { action: "move", path: "a", destination: "b" },
      }),
    ).toMatchObject({
      past: "Moved",
      subject: "a → b",
    });
    expect(
      describeTool({
        name: "manage_files",
        arguments: { action: "trash", path: "a" },
      }).past,
    ).toBe("Moved to Trash");
    expect(
      describeTool({ name: "search_text", arguments: { query: "budget" } })
        .subject,
    ).toBe("“budget”");
    expect(
      describeTool({ name: "edit_file", arguments: { path: "a.md" } }).kind,
    ).toBe("write");
  });
  it("names plugins and surfaces their ID for the logo", () => {
    const view = describeTool({
      name: "call_plugin_tool",
      arguments: { pluginId: "github", name: "create_issue" },
    });
    expect(view).toMatchObject({
      plugin: "github",
      subject: "GitHub · create_issue",
      kind: "plugin",
    });
    expect(
      describeTool({
        name: "load_skill",
        arguments: { id: "project-planning" },
      }).subject,
    ).toBe("Project planning");
  });
  it("degrades gracefully for unknown tools and bad arguments", () => {
    expect(
      describeTool({ name: "future_tool_name", arguments: {} }),
    ).toMatchObject({
      kind: "other",
      past: "Future tool name",
    });
    expect(() =>
      // @ts-expect-error arguments can be absent in old data
      describeTool({ name: "read_file", arguments: undefined }),
    ).not.toThrow();
    expect(
      describeTool({ name: "read_file", arguments: { path: 42 } }).subject,
    ).toBe("a file");
    expect(
      describeTool({
        name: "run_command",
        arguments: { command: "x".repeat(500) },
      }).subject.length,
    ).toBeLessThanOrEqual(90);
  });
});

describe("activity text helpers", () => {
  it("summarizes a group compactly", () => {
    expect(
      summarizeActivity([
        { name: "read_file", arguments: {} },
        { name: "read_file", arguments: {} },
        { name: "run_command", arguments: {} },
        { name: "edit_file", arguments: {} },
      ]),
    ).toBe("Read 2 files, ran 1 command, edited 1 file");
    expect(summarizeActivity([{ name: "mystery", arguments: {} }])).toBe(
      "Used 1 tool",
    );
  });
  it("distinguishes discovery and saved-result reads from real plugin actions and file reads", () => {
    expect(
      summarizeActivity([
        { name: "search_plugin_tools", arguments: { pluginId: "linear" } },
        { name: "search_plugin_tools", arguments: { pluginId: "linear" } },
        { name: "read_tool_output", arguments: {} },
        {
          name: "call_plugin_tool",
          arguments: { pluginId: "linear", name: "list_teams" },
        },
      ]),
    ).toBe("Made 2 tool lookups, read 1 saved result, ran 1 plugin action");
  });
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(3_400)).toBe("3.4s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
  it("marks attention states", () => {
    const icon = WrenchIcon;
    expect(statusIcon("pendingApproval", icon).tone).toBe("warning");
    expect(statusIcon("failed", icon).tone).toBe("error");
    expect(statusIcon("unknown", icon).tone).toBe("error");
    expect(statusIcon("completed", icon).Icon).toBe(icon);
  });
  it("shimmers work in progress instead of swapping in a spinner", () => {
    const icon = WrenchIcon;
    // A running tool keeps its own icon; the text carries the motion.
    expect(statusIcon("running", icon)).toMatchObject({ Icon: icon, shimmer: true });
    expect(statusIcon("pendingExecution", icon).shimmer).toBe(true);
    for (const status of ["pendingApproval", "completed", "failed", "denied", "unknown"] as const) {
      expect(statusIcon(status, icon).shimmer).toBe(false);
    }
  });
});

describe("lineDiff", () => {
  it("shows what an edit changed", () => {
    const lines = lineDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma\ndelta");
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "same:alpha",
      "del:beta",
      "add:BETA",
      "same:gamma",
      "add:delta",
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines[1]).toMatchObject({ oldLine: 2 });
    expect(lines[2]).toMatchObject({ newLine: 2 });
  });
  it("handles empty sides and identical text", () => {
    expect(diffStats(lineDiff("", "a\nb"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(lineDiff("a\nb", ""))).toEqual({ added: 0, removed: 2 });
    expect(diffStats(lineDiff("same", "same"))).toEqual({
      added: 0,
      removed: 0,
    });
    expect(lineDiff("", "")).toEqual([]);
  });
  it("does not stall on very large inputs", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const started = Date.now();
    const lines = lineDiff(big, big + "\nextra");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.length).toBeGreaterThan(0);
  });
  it("keeps every line of a large change so it can be reviewed in full", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
    const lines = lineDiff("", huge);
    expect(lines).toHaveLength(5000);
    expect(lines.at(-1)).toMatchObject({ type: "add", text: "row 4999" });
    expect(
      lineDiff(huge, "").filter((line) => line.type === "del"),
    ).toHaveLength(5000);
  });
});
