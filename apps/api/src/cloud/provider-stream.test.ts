import { describe, expect, it, vi } from "vitest";
import { providerStreamRepair, withoutRepeatedCallId } from "./provider-stream.js";

const frame = (call: object) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}`;
const ids = (text: string) => {
  const found: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    for (const call of JSON.parse(line.slice(5)).choices[0].delta.tool_calls ?? [])
      if (call.id) found[call.index] = (found[call.index] ?? "") + call.id;
  }
  return found;
};
async function run(chunks: (string | Buffer)[]) {
  const stream = providerStreamRepair({ onStalled: () => undefined });
  const parts: Buffer[] = [];
  stream.on("data", (part: Buffer) => parts.push(part));
  for (const chunk of chunks) stream.write(Buffer.from(chunk as string));
  stream.end();
  await new Promise((resolve) => stream.once("end", resolve));
  return Buffer.concat(parts).toString("utf8");
}

describe("withoutRepeatedCallId", () => {
  it("drops an ID repeated in a later chunk and keeps the rest of the delta", () => {
    const seen = new Map<string, string>();
    const first = frame({ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } });
    expect(withoutRepeatedCallId(first, seen)).toBe(first);
    const repeat = withoutRepeatedCallId(frame({ index: 0, id: "call_a", function: { arguments: "{}" } }), seen);
    expect(JSON.parse(repeat.slice(5)).choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: "{}" } });
  });
  it("tracks each parallel call separately", () => {
    const seen = new Map<string, string>();
    for (const line of [frame({ index: 0, id: "same" }), frame({ index: 1, id: "same" })])
      expect(withoutRepeatedCallId(line, seen)).toBe(line);
  });
  it("still joins an ID that really is sent in fragments", () => {
    const seen = new Map<string, string>();
    const second = frame({ index: 0, id: "part-two" });
    withoutRepeatedCallId(frame({ index: 0, id: "part-one-" }), seen);
    expect(withoutRepeatedCallId(second, seen)).toBe(second);
  });
  it("leaves anything it cannot read alone", () => {
    const seen = new Map<string, string>();
    for (const line of ['data: {"tool_calls":', "data: [DONE]", ': comment "tool_calls"', 'data: {"tool_calls":[]}'])
      expect(withoutRepeatedCallId(line, seen)).toBe(line);
  });
  it("keeps a CRLF line ending so the event still closes", () => {
    const seen = new Map<string, string>();
    withoutRepeatedCallId(frame({ index: 0, id: "call_a" }), seen);
    expect(withoutRepeatedCallId(`${frame({ index: 0, id: "call_a" })}\r`, seen).endsWith("}\r")).toBe(true);
  });
});

describe("providerStreamRepair", () => {
  it("delivers each ID once, however the bytes are split", async () => {
    const body = `${frame({ index: 0, id: "call_a", function: { name: "x", arguments: "" } })}\n\n${frame({ index: 0, id: "call_a", function: { arguments: "{}" } })}\n\ndata: [DONE]\n\n`;
    for (const size of [1, 7, 64, body.length]) {
      const chunks: string[] = [];
      for (let at = 0; at < body.length; at += size) chunks.push(body.slice(at, at + size));
      const output = await run(chunks);
      expect(ids(output)).toEqual({ 0: "call_a" });
      expect(output.endsWith("data: [DONE]\n\n")).toBe(true);
    }
  });
  it("keeps text byte for byte, including characters split across chunks", async () => {
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"नमस्ते"}}]}\n\n');
    expect(await run([bytes.subarray(0, 37), bytes.subarray(37)])).toBe(bytes.toString("utf8"));
  });
  it("passes along a stream that ends without a final newline", async () => {
    expect(await run(["data: [DONE]"])).toBe("data: [DONE]");
  });

  describe("while the model is silent", () => {
    function silent(chunk: string) {
      vi.useFakeTimers();
      const onStalled = vi.fn();
      const stream = providerStreamRepair({ onStalled, keepAliveMs: 1000, stalledMs: 5000, now: Date.now });
      const parts: string[] = [];
      stream.on("data", (part: Buffer) => parts.push(part.toString()));
      stream.write(chunk);
      return { onStalled, parts, stream };
    }
    it("sends a comment between events, then gives up on a stalled provider", async () => {
      const t = silent('data: {"choices":[]}\n\n');
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.parts.at(-1)).toBe(": keep-alive\n\n");
      expect(t.onStalled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000);
      expect(t.onStalled).toHaveBeenCalledOnce();
      t.stream.destroy();
      vi.useRealTimers();
    });
    it("never interrupts an unfinished event", async () => {
      const t = silent('event: x\ndata: {"partial":');
      await vi.advanceTimersByTimeAsync(3000);
      expect(t.parts.join("")).not.toContain("keep-alive");
      t.stream.destroy();
      vi.useRealTimers();
    });
    it("stops its timer when the stream ends", async () => {
      const t = silent("data: [DONE]\n\n");
      t.stream.destroy();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.onStalled).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
