import { describe, expect, it, vi } from "vitest";
import { readProviderRefusal } from "./provider-refusal.js";

describe("provider refusal body budget", () => {
  it("stops and cancels an endless error stream without waiting for its end", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("unknown model ".repeat(1000)));
      },
      cancel,
    }), { status: 400, headers: { "content-length": "1" } });
    const prefix = await readProviderRefusal(response);
    expect(Buffer.byteLength(prefix)).toBe(4096);
    expect(prefix).toContain("unknown model");
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(2);
  });
  it("preserves normal classification text split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"error":"unknown model: 日本語"}');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }));
    expect(await readProviderRefusal(response)).toBe(new TextDecoder().decode(bytes));
  });
  it("returns no text for a failed or absent stream", async () => {
    expect(await readProviderRefusal(new Response(null, { status: 400 }))).toBe("");
    expect(await readProviderRefusal(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("synthetic secret")); },
    })))).toBe("");
  });
});
