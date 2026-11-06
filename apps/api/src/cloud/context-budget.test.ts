import { describe, expect, it } from "vitest";
import {
  COMPACTION_LEVELS,
  assembleMessages,
  shorten,
  type AssembleInput,
  type PriorRound,
} from "./context-budget.js";
import { planningTokens } from "./continuation.js";
import { modelOutput } from "./tools.js";

const big = (label: string, size = 20_000) => ({ text: `${label} `.repeat(Math.ceil(size / (label.length + 1))) });
const png = "iVBORw0KGgo=";
const round = (index: number, name = "inspect_document", output: unknown = big(`r${index}`)): PriorRound => ({
  index,
  assistant: { text: `step ${index}`, native: { role: "assistant", content: null, tool_calls: [{ id: `c${index}`, type: "function", function: { name, arguments: "{}" } }] } },
  calls: [{
    id: `c${index}`, name, status: "completed", invocationId: `00000000-0000-4000-8000-00000000000${index % 10}`,
    output, rawOutput: name === "view_image" ? { path: "p.png", image: { mimeType: "image/png", data: png } } : output,
  }],
});
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i} ${"x".repeat(3000)}`,
    attachments: i === 0 ? ["a.docx"] : [],
  }));
const input = (overrides: Partial<AssembleInput> = {}): AssembleInput => ({
  protocol: "openai", index: 6, history: history(3), rounds: [], preface: [], ...overrides,
});
const size = (messages: unknown[]) => planningTokens({ messages });
const contents = (messages: unknown[]) => messages.map((m) => String((m as { content?: unknown }).content ?? ""));

describe("assembleMessages", () => {
  it("carries the whole conversation and every receipt at full detail", () => {
    const messages = assembleMessages(input({ history: history(4), rounds: [round(0), round(5)] }), COMPACTION_LEVELS[0]!);
    expect(contents(messages)[0]).toContain("Attached workspace files: a.docx");
    expect(messages.filter((m) => (m as { role: string }).role === "tool")).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
  });

  it("keeps recent results larger than old ones", () => {
    const messages = assembleMessages(input({ rounds: [round(0), round(5)] }), COMPACTION_LEVELS[0]!);
    const tools = messages.filter((m) => (m as { role: string }).role === "tool") as { content: string }[];
    expect(tools[0]!.content.length).toBeLessThan(tools[1]!.content.length);
  });

  it("puts memory and receipt notes first, in order", () => {
    const messages = assembleMessages(input({ preface: ["memory", "receipts"] }), COMPACTION_LEVELS[0]!);
    expect(contents(messages).slice(0, 2)).toEqual(["memory", "receipts"]);
  });

  it("speaks Anthropic's shapes: tool results in one user turn, images after them", () => {
    const rounds = [round(5, "view_image")];
    rounds[0]!.assistant.native = [{ type: "tool_use", id: "c5", name: "view_image", input: {} }];
    const messages = assembleMessages(input({ protocol: "anthropic", rounds }), COMPACTION_LEVELS[0]!);
    const tail = messages.slice(-3) as { role: string; content: { type: string }[] }[];
    expect(tail[0]).toMatchObject({ role: "assistant" });
    expect(tail[1]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c5" });
    expect(tail[2]!.content.map((part) => part.type)).toEqual(["text", "image"]);
  });

  describe("compaction", () => {
    const heavy = () =>
      input({
        index: 12,
        // Odd length: the conversation ends on the member's message, as it always does.
        history: history(41),
        rounds: Array.from({ length: 12 }, (_, i) => round(i, i % 3 === 0 ? "view_image" : "inspect_document")),
      });
    it("shrinks at every level, never growing", () => {
      const sizes = COMPACTION_LEVELS.map((level) => size(assembleMessages(heavy(), level)));
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]!);
      expect(sizes.at(-1)!).toBeLessThan(sizes[0]! / 5);
    });

    it("never touches the member's latest message or the newest results", () => {
      const source = heavy();
      const latest = source.history.at(-1)!;
      for (const level of COMPACTION_LEVELS) {
        const messages = assembleMessages(source, level);
        const users = messages.filter((m) => (m as { role: string }).role === "user" && typeof (m as { content: unknown }).content === "string");
        expect(contents(users).some((text) => text.startsWith(latest.text))).toBe(true);
      }
      const newest = assembleMessages(source, COMPACTION_LEVELS.at(-1)!).filter((m) => (m as { role: string }).role === "tool").at(-1) as { content: string };
      expect(newest.content.length).toBeGreaterThan(300);
    });

    it("drops old images first and keeps the newest while it can", () => {
      const countImages = (level: number) =>
        assembleMessages(heavy(), COMPACTION_LEVELS[level]!).filter((m) => Array.isArray((m as { content: unknown }).content)).length;
      expect(countImages(0)).toBeGreaterThanOrEqual(countImages(1));
      expect(countImages(3)).toBe(0);
    });

    it("drops the oldest turns last, tells the model, and never opens on a reply", () => {
      const smallest = assembleMessages(heavy(), COMPACTION_LEVELS.at(-1)!);
      const note = contents(smallest).find((text) => text.includes("left out to fit"));
      expect(note).toMatch(/\[\d+ earlier messages?/);
      const roles = smallest.filter((m) => !(m as { tool_call_id?: string }).tool_call_id).map((m) => (m as { role: string }).role);
      expect(roles[0]).toBe("user");
      expect(contents(smallest).some((text) => text.startsWith("message 0"))).toBe(false);
    });

    it("shortens older long messages but not the recent ones", () => {
      const messages = assembleMessages(input({ history: history(20) }), COMPACTION_LEVELS[3]!);
      const texts = contents(messages).filter((text) => text.startsWith("message"));
      expect(texts.at(-1)!.length).toBeGreaterThan(3000);
      expect(texts[0]!.length).toBeLessThan(1700);
      expect(texts[0]).toContain("shortened to fit");
    });

    it("is deterministic", () => {
      expect(assembleMessages(heavy(), COMPACTION_LEVELS[2]!)).toEqual(assembleMessages(heavy(), COMPACTION_LEVELS[2]!));
    });
  });
});

describe("bounded tool receipts", () => {
  it.each(["openai", "anthropic"] as const)("exposes host-owned evidence IDs for short %s results without replacing paging sources", protocol => {
    const source = "00000000-0000-4000-8000-000000000099";
    const receipt = round(0, "read_tool_output", { text: "short", receiptId: "forged", invocationId: source, nextOffset: 5 });
    const messages = assembleMessages(input({ protocol, index: 1, history: [], rounds: [receipt] }), COMPACTION_LEVELS[0]!);
    const wire = messages.at(-1) as { content: string | { text?: string; content: string }[] };
    const result = JSON.parse(typeof wire.content === "string" ? wire.content : wire.content[0]!.content);
    expect(result.receiptId).toBe(receipt.calls[0]!.invocationId);
    expect(result.invocationId).toBe(source);
    expect(result.nextOffset).toBe(5);
    expect(result.text).toBe("short");
  });
  it("retains non-object tool results inside a receipt", () => {
    const receipt = round(0, "list_files", ["a", "b"]);
    const messages = assembleMessages(input({ index: 1, history: [], rounds: [receipt] }), COMPACTION_LEVELS[0]!);
    const result = JSON.parse((messages.at(-1) as { content: string }).content);
    expect(result).toEqual({ result: ["a", "b"], receiptId: receipt.calls[0]!.invocationId });
  });
  it("always terminate, even when the budget is smaller than the receipt's own fields", () => {
    // Once looped forever: the receipt envelope alone is larger than these budgets.
    for (const budget of [0, 1, 40, 100, 192, 300]) {
      const receipt = modelOutput({ text: "x".repeat(50_000) }, "00000000-0000-4000-8000-000000000001", budget) as Record<string, unknown>;
      expect(JSON.stringify(receipt).length).toBeLessThan(2_200);
    }
  });
  it("still points at the full output so nothing is lost", () => {
    const receipt = modelOutput({ text: "x".repeat(50_000) }, "00000000-0000-4000-8000-000000000001", 512) as Record<string, unknown>;
    expect(JSON.stringify(receipt)).toContain("00000000-0000-4000-8000-000000000001");
  });
});

describe("shorten", () => {
  it("leaves short text alone and never splits a surrogate pair", () => {
    expect(shorten("short", 10)).toBe("short");
    const cut = shorten("a😀b", 2);
    expect(cut.startsWith("a")).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
