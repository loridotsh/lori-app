import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  cloudUsageObserver,
  normalizeProviderUsage,
  mergeUsage,
} from "./usage.js";
describe("Cloud provider usage semantics", () => {
  it("preserves unknowns and cache-exclusive input without adding reasoning twice", () => {
    expect(
      normalizeProviderUsage("openai", {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toEqual({
      costMicrousd: null,
      inputTokens: 100,
      outputTokens: 20,
      uncachedInputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      reasoningTokens: 5,
    });
    expect(
      normalizeProviderUsage("anthropic", {
        input_tokens: 20,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      }),
    ).toMatchObject({
      uncachedInputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
    expect(normalizeProviderUsage("openai", {})).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    });
    expect(
      mergeUsage(
        { inputTokens: 20, cacheReadTokens: 80 },
        { inputTokens: null, outputTokens: 10 },
      ),
    ).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 80 });
  });
  it("never lets a later zero erase a real count", async () => {
    expect(mergeUsage({ outputTokens: 40 }, { outputTokens: 0 }).outputTokens).toBe(40);
    expect(mergeUsage(undefined, { outputTokens: 0 }).outputTokens).toBe(0);
    const reports: { outputTokens?: number | null }[] = [];
    const observer = cloudUsageObserver("openai", async (usage) => { reports.push(usage); });
    observer.resume();
    observer.end('data: {"usage":{"prompt_tokens":5,"completion_tokens":40}}\n\ndata: {"usage":{"completion_tokens":0}}\n\n');
    await new Promise((resolve) => observer.once("end", resolve));
    expect(reports.at(-1)?.outputTokens).toBe(40);
  });
  it("commits usage before forwarding exact byte framing to a worker", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let recorded = false,
      forwarded = false;
    const body = Buffer.from(
      'data: {"usage":{"prompt_tokens":12}}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const observer = cloudUsageObserver("openai", async (usage) => {
      expect(usage).toMatchObject({ inputTokens: 12, outputTokens: null });
      await gate;
      recorded = true;
    });
    observer.on("data", () => {
      forwarded = true;
      expect(recorded).toBe(true);
    });
    const consumed = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from([body]).pipe(observer))
        chunks.push(chunk);
      return Buffer.concat(chunks);
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(forwarded).toBe(false);
    release();
    expect(await consumed).toEqual(body);
  });
});

describe("Work usage reporting regressions", () => {
  it("retains unpriced token reports and accepts zero cost without inventing a price", () => {
    expect(normalizeProviderUsage("openai", { prompt_tokens: 7, completion_tokens: 3 })).toMatchObject({ inputTokens: 7, outputTokens: 3, costMicrousd: null });
    expect(normalizeProviderUsage("openai", { cost: 0 })).toMatchObject({ costMicrousd: 0 });
    expect(normalizeProviderUsage("openai", { cost: 0.00125 })).toMatchObject({ costMicrousd: 1250 });
    for (const cost of [-1, Infinity, "0.5", Number.MAX_VALUE]) expect(normalizeProviderUsage("openai", { cost }).costMicrousd).toBeNull();
  });
  it("merges split cache counters and nested Responses usage without changing stream bytes", async () => {
    const reports: ReturnType<typeof normalizeProviderUsage>[] = [];
    const body = Buffer.from('data: null\n\ndata: {"usage":{"prompt_tokens":100}}\n\ndata: {"usage":{"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":10,"cost":0.002}}\n\ndata: {"response":{"usage":{"completion_tokens":20}}}\n\n');
    const observer = cloudUsageObserver("openai", async (usage) => { reports.push(usage); });
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.from([body.subarray(0, 23), body.subarray(23)]).pipe(observer)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(reports.at(-1)).toMatchObject({ inputTokens: 100, uncachedInputTokens: 20, cacheReadTokens: 80, outputTokens: 20, costMicrousd: 2000 });
  });
});

it("records Groq's nested streaming usage and cache counters", async () => {
  const reports: ReturnType<typeof normalizeProviderUsage>[]=[];
  const observer=cloudUsageObserver("openai",async u=>{reports.push(u);});
  for await (const _chunk of Readable.from(['data: {"x_groq":{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}}\n\n']).pipe(observer)) { /* drain */ }
  expect(reports[0]).toMatchObject({inputTokens:100,outputTokens:20,uncachedInputTokens:20,cacheReadTokens:80});
});

it("does not erase valid counters when a later frame contains malformed numbers", async () => {
  const reports: ReturnType<typeof normalizeProviderUsage>[] = [];
  const observer=cloudUsageObserver("openai",async u=>{reports.push(u);});
  const frames=['data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n','data: {"usage":{"prompt_tokens":9007199254740992,"completion_tokens":1.5}}\n\n'];
  for await (const _chunk of Readable.from(frames).pipe(observer)) { /* drain */ }
  expect(reports.at(-1)).toMatchObject({inputTokens:100,outputTokens:20});
});
