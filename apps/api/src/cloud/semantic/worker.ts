import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import ort from "onnxruntime-node";
import { chunks, dot, manifest } from "./ranking.js";
import { UnigramTokenizer } from "./tokenizer.js";

type Request =
  | { id: number; op: "query"; text: string; deadline: number }
  | { id: number; op: "passage"; header: string; body: string; deadline: number };

const dir = process.env.LORI_SEMANTIC_MODEL_DIR ?? "";
const threads = Math.max(1, Math.min(4, Number(process.env.LORI_SEMANTIC_THREADS) || 1));
const local = (name: string) => join(dir, name.split("/").at(-1)!);

async function verify(name: string) {
  const expected = manifest.files[name];
  if (!expected) throw new Error("unpinned");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(local(name))) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error("integrity");
}

for (const name of ["onnx/model_quantized.onnx", "tokenizer.json"]) await verify(name);
const tokenizer = new UnigramTokenizer(readFileSync(local("tokenizer.json"), "utf8"));
const session = await ort.InferenceSession.create(local("onnx/model_quantized.onnx"), {
  intraOpNumThreads: threads,
  interOpNumThreads: 1,
  executionMode: "sequential",
  graphOptimizationLevel: "all",
});

function tokens(text: string) {
  const ids = tokenizer.encode(text);
  return ids.length > manifest.maxTokens ? [...ids.slice(0, manifest.maxTokens - 1), 2] : ids;
}

async function embed(text: string): Promise<Float32Array> {
  const ids = tokens(text), n = ids.length;
  const output = await session.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, n]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
    token_type_ids: new ort.Tensor("int64", new BigInt64Array(n), [1, n]),
  });
  const hidden = output.last_hidden_state!.data as Float32Array, d = manifest.dimensions;
  if (hidden.length !== n * d) throw new Error("shape");
  const vector = new Float32Array(d);
  for (let t = 0; t < n; t++) for (let i = 0; i < d; i++) vector[i]! += hidden[t * d + i]!;
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("degenerate");
  for (let i = 0; i < d; i++) vector[i]! /= norm;
  return vector;
}

const centroid = new Float32Array(manifest.dimensions);
for (const anchor of manifest.gate.anchors) {
  const v = await embed(manifest.passagePrefix + anchor);
  for (let i = 0; i < v.length; i++) centroid[i]! += v[i]! / manifest.gate.anchors.length;
}

const queries: Request[] = [], passages: Request[] = [];
let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  try {
    for (let next = queries.shift() ?? passages.shift(); next; next = queries.shift() ?? passages.shift()) {
      if (Date.now() > next.deadline) { process.send?.({ id: next.id, ok: false, error: "expired" }); continue; }
      try {
        if (next.op === "query") {
          const vector = await embed(manifest.queryPrefix + next.text);
          process.send?.({ id: next.id, ok: true, vector, floor: dot(vector, centroid) + manifest.gate.minMarginOverAnchorMean });
        } else {
          const spans = chunks(text => Math.max(0, tokenizer.encode(text).length - 2), next.body);
          const out = [];
          for (const [start, end] of spans) out.push({ start, end, vector: await embed(`${manifest.passagePrefix}${next.header ? `${next.header}\n` : ""}${next.body.slice(start, end)}`) });
          process.send?.({ id: next.id, ok: true, chunks: out });
        }
      } catch {
        process.send?.({ id: next.id, ok: false, error: "embedding_failed" });
      }
    }
  } finally {
    busy = false;
  }
}

process.on("message", (message: Request) => {
  (message.op === "query" ? queries : passages).push(message);
  void drain();
});
process.on("disconnect", () => process.exit(0));
process.send?.({ ready: true });
