import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface SemanticManifest {
  id: string;
  source: string;
  files: Record<string, { sha256: string; size: number }>;
  dimensions: number;
  maxTokens: number;
  queryPrefix: string;
  passagePrefix: string;
  chunkTokens: number;
  overlapTokens: number;
  candidates: number;
  rrfK: number;
  gate: { minMarginOverAnchorMean: number; anchors: string[] };
}
/** Shared byte-for-byte with Lori desktop: model pin, preprocessing and ranking constants. */
export const manifest: SemanticManifest = JSON.parse(readFileSync(new URL("../../../semantic/manifest.json", import.meta.url), "utf8"));

export interface Probe { vector: Float32Array; floor: number }
export interface Chunk { start: number; end: number; vector: Float32Array }
export interface StoredChunk { start: number; end: number; scale: number; bytes: Buffer }

export function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function quantize(vector: Float32Array): { scale: number; bytes: Buffer } {
  let max = 0;
  for (const v of vector) max = Math.max(max, Math.abs(v));
  const scale = max > 0 ? max / 127 : 1;
  const bytes = Buffer.alloc(vector.length);
  for (let i = 0; i < vector.length; i++) bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(vector[i]! / scale))), i);
  return { scale, bytes };
}

/** Cosine against an int8 vector; null for a corrupt or foreign-dimension row. */
export function score(probe: Float32Array, scale: number, bytes: Uint8Array): number | null {
  if (bytes.length !== probe.length || !Number.isFinite(scale)) return null;
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += probe[i]! * values[i]!;
  return sum * scale;
}

/** Reciprocal-rank fusion; ties by best rank, then id, exactly as the desktop. */
export function fuse(lists: string[][]): string[] {
  const scores = new Map<string, { score: number; rank: number }>();
  for (const list of lists)
    list.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, rank: Number.MAX_SAFE_INTEGER };
      entry.score += 1 / (manifest.rrfK + index + 1);
      entry.rank = Math.min(entry.rank, index);
      scores.set(id, entry);
    });
  return [...scores].sort((a, b) => b[1].score - a[1].score || a[1].rank - b[1].rank || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id);
}

export function fingerprint(header: string, body: string) {
  return createHash("sha256").update(`${manifest.id}\0${header}\0${body}`).digest("hex");
}

/** Sentence/paragraph chunks of at most chunkTokens with a whole-sentence overlap of at most overlapTokens. */
export function chunks(count: (text: string) => number, body: string): [number, number][] {
  const limit = manifest.chunkTokens;
  const units: [number, number, number][] = [];
  const chars = [...body];
  const offsets: number[] = [];
  let at = 0;
  for (const c of chars) { offsets.push(at); at += c.length; }
  offsets.push(at);
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!, next = chars[i + 1];
    const boundary = c === "\n" || (/^[.!?।॥。]$/.test(c) && (next === undefined || /^\s$/u.test(next)));
    if (boundary || next === undefined) {
      let end = i + 1;
      while (end < chars.length && /^\s$/u.test(chars[end]!)) end++;
      unit(count, body, offsets[start]!, offsets[end]!, limit, units);
      start = end;
      i = end - 1;
    }
  }
  const spans: [number, number][] = [];
  let first = 0;
  while (first < units.length) {
    let last = first, tokens = units[first]![2];
    while (last + 1 < units.length && tokens + units[last + 1]![2] <= limit) tokens += units[++last]![2];
    spans.push([units[first]![0], units[last]![1]]);
    if (last + 1 >= units.length) break;
    let next = last + 1, overlap = 0;
    while (next > first + 1 && overlap + units[next - 1]![2] <= manifest.overlapTokens) overlap += units[--next]![2];
    first = next;
  }
  return spans;
}

function unit(count: (text: string) => number, body: string, start: number, end: number, limit: number, units: [number, number, number][]) {
  if (!body.slice(start, end).trim()) {
    const last = units.at(-1);
    if (last) last[1] = end;
    return;
  }
  const total = count(body.slice(start, end));
  if (total <= limit) { units.push([start, end, total]); return; }
  let piece = start, tokens = 0, cursor = start;
  for (const word of body.slice(start, end).match(/\S*\s*/gu)!.filter(Boolean)) {
    const next = cursor + word.length, size = count(word);
    if (size > limit) {
      if (cursor > piece) units.push([piece, cursor, tokens]);
      let slice = cursor, index = 0, offset = cursor;
      for (const ch of word) {
        if (index > 0 && index % limit === 0) { units.push([slice, offset, count(body.slice(slice, offset))]); slice = offset; }
        index++; offset += ch.length;
      }
      piece = slice; tokens = count(body.slice(slice, next)); cursor = next;
      continue;
    }
    if (tokens + size > limit && cursor > piece) { units.push([piece, cursor, tokens]); piece = cursor; tokens = 0; }
    tokens += size; cursor = next;
  }
  if (cursor > piece) units.push([piece, cursor, tokens]);
}

export function encodeChunks(list: Chunk[]) {
  return list.map(c => { const q = quantize(c.vector); return { start: c.start, end: c.end, scale: q.scale, vector: q.bytes.toString("base64") }; });
}

export function bestScore(probe: Probe, stored: { scale: number; vector: string }[]) {
  let best = -Infinity;
  for (const c of stored) { const s = score(probe.vector, c.scale, Buffer.from(c.vector, "base64")); if (s !== null) best = Math.max(best, s); }
  return best;
}
