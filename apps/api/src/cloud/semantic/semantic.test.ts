import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SemanticEmbedder } from "./embedder.js";
import { bestScore, chunks, dot, encodeChunks, fingerprint, fuse, manifest, quantize, score } from "./ranking.js";
import { UnigramTokenizer } from "./tokenizer.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../semantic/fixtures/${name}`, import.meta.url), "utf8"));
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("semantic ranking", () => {
  it("matches the ranking fixture shared with Lori desktop", () => {
    const ranking = fixture("ranking.json");
    expect(ranking.rrfK).toBe(manifest.rrfK);
    for (const c of ranking.cases) expect(fuse([c.lexical, c.semantic])).toEqual(c.expected);
  });

  it("pins verified model assets", () => {
    for (const name of ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"]) {
      expect(manifest.files[name]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.files[name]?.size).toBeGreaterThan(0);
    }
    expect(manifest.source).toContain("761b726dd34fb83930e26aab4e9ac3899aa1fa78");
    expect(manifest.dimensions).toBe(384);
  });

  it("quantizes without changing ranking and rejects corrupt rows", () => {
    const v = new Float32Array(384).map((_, i) => Math.sin(i));
    const norm = Math.hypot(...v);
    const unit = v.map(x => x / norm);
    const { scale, bytes } = quantize(unit);
    expect(Math.abs(score(unit, scale, bytes)! - 1)).toBeLessThan(0.01);
    expect(score(unit, scale, bytes.subarray(0, 10))).toBeNull();
    expect(score(unit, Number.NaN, bytes)).toBeNull();
    const stored = encodeChunks([{ start: 0, end: 1, vector: unit }]);
    expect(bestScore({ vector: unit, floor: 0 }, stored)).toBeGreaterThan(0.99);
  });

  it("chunks long text with bounded size, full coverage and overlap", () => {
    const sentence = Array(100).fill("word").join(" ");
    const text = [sentence, sentence, sentence, sentence, sentence].join(".\n") + ".";
    const spans = chunks(words, text);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0]![0]).toBe(0);
    expect(spans.at(-1)![1]).toBe(text.length);
    for (const [s, e] of spans) expect(words(text.slice(s, e))).toBeLessThanOrEqual(manifest.chunkTokens);
    for (let i = 1; i < spans.length; i++) { expect(spans[i]![0]).toBeLessThanOrEqual(spans[i - 1]![1]); expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![0]); }
    expect(chunks(words, "x".repeat(2000)).at(-1)![1]).toBe(2000);
    expect(chunks(words, "")).toEqual([]);
    expect(chunks(words, "Keep answers concise.")).toEqual([[0, 21]]);
    expect(chunks(words, "मेरी बेटी का जन्मदिन 5 मार्च को है। अगला वाक्य।")).toHaveLength(1);
  });

  it("binds fingerprints to the model and the exact text", () => {
    expect(fingerprint("a", "b")).not.toBe(fingerprint("a", "c"));
    expect(fingerprint("ab", "")).not.toBe(fingerprint("a", "b"));
  });
});

describe("semantic embedder", () => {
  it("includes a stalled cold startup in the query deadline", async () => {
    vi.useFakeTimers();
    const embedder = new SemanticEmbedder();
    vi.spyOn(embedder, "available", "get").mockReturnValue(true);
    // Simulate a child that never becomes ready; no real process or model is needed.
    const startup = vi.spyOn(embedder as unknown as { start(): Promise<boolean> }, "start").mockReturnValue(new Promise(() => {}));
    try {
      let finished = false;
      const result = embedder.query("cold request").then(value => { finished = true; return value; });
      await vi.advanceTimersByTimeAsync(1500);
      expect(finished).toBe(true);
      expect(await result).toBeNull();
    } finally {
      startup.mockRestore();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it("falls back to null when disabled or the model is absent", async () => {
    const off = new SemanticEmbedder({ ...process.env, LORI_SEMANTIC_MEMORY: "off" });
    expect(off.available).toBe(false);
    expect(await off.query("anything")).toBeNull();
    const missing = new SemanticEmbedder({ ...process.env, LORI_SEMANTIC_MODEL_DIR: "/nonexistent/semantic-model" });
    expect(missing.available).toBe(false);
    expect(await missing.passage("", "text")).toBeNull();
    expect(missing.peek("anything")).toBeNull();
  });

  const embedder = new SemanticEmbedder({ ...process.env, LORI_SEMANTIC_MEMORY: "" });
  it.skipIf(!embedder.available)("tokenizes exactly like Lori desktop on the shared multilingual fixture", () => {
    const compact = new UnigramTokenizer(readFileSync(`${embedder.directory}/tokenizer.json`, "utf8"));
    for (const c of [...fixture("golden.json").cases, ...fixture("tokens.json").cases]) expect(compact.encode(c.text)).toEqual(c.ids);
  });
  it.skipIf(!embedder.available)("matches golden reference embeddings and gates irrelevant queries", { timeout: 120_000 }, async () => {
    // Accuracy is measured warm; cold queries intentionally fall back within 1.5s.
    expect(await embedder.passage("", "Warm up the local embedding model.")).not.toBeNull();
    const golden = fixture("golden.json");
    for (const c of golden.cases) {
      const text: string = c.text;
      const expected = Float32Array.from(c.vector as number[]);
      if (text.startsWith(manifest.queryPrefix)) {
        const probe = await embedder.query(text.slice(manifest.queryPrefix.length));
        expect(probe).not.toBeNull();
        expect(dot(probe!.vector, expected)).toBeGreaterThan(golden.minCosine);
        expect(embedder.peek(text.slice(manifest.queryPrefix.length))).toBe(probe);
      } else {
        const passage = await embedder.passage("", text.slice(manifest.passagePrefix.length));
        expect(passage).toHaveLength(1);
        expect(dot(passage![0]!.vector, expected)).toBeGreaterThan(golden.minCosine);
      }
    }
    const [note] = (await embedder.passage("pet", "My dog Bruno needs his medicine twice a day."))!;
    const relevant = (await embedder.query("कुत्ते को दवा कितनी बार देनी है?"))!;
    const irrelevant = (await embedder.query("Who wrote Pride and Prejudice?"))!;
    expect(dot(relevant.vector, note!.vector)).toBeGreaterThanOrEqual(relevant.floor);
    expect(dot(irrelevant.vector, note!.vector)).toBeLessThan(irrelevant.floor);
    embedder.close();
  });
});
