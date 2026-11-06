/**
 * Compact XLM-R SentencePiece Unigram tokenizer, identical to Lori desktop's: the
 * precompiled charsmap normalizer, Metaspace pre-tokenization and Viterbi decoding.
 * A plain map keeps memory near the vocabulary size instead of a per-character trie.
 */
const SPECIAL: [string, number][] = [["<s>", 0], ["<pad>", 1], ["</s>", 2], ["<unk>", 3], ["<mask>", 250001]];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class Charsmap {
  private trie: Uint32Array;
  private normalized: Buffer;
  constructor(bytes: Buffer) {
    const size = bytes.readUInt32LE(0);
    if (size % 4 || 4 + size > bytes.length) throw new Error("charsmap");
    this.trie = new Uint32Array(size / 4);
    for (let i = 0; i < this.trie.length; i++) this.trie[i] = bytes.readUInt32LE(4 + i * 4);
    this.normalized = bytes.subarray(4 + size);
  }
  private transform(chunk: string): string | null {
    const key = Buffer.from(chunk, "utf8");
    const offset = (u: number) => (u >>> 10) * (u & 512 ? 256 : 1);
    let node = 0, unit = this.trie[0]!;
    node ^= offset(unit);
    for (const c of key) {
      if (c === 0) break;
      node ^= c;
      unit = this.trie[node]!;
      if (unit === undefined || ((unit & 0x800000ff) >>> 0) !== c) return null;
      node ^= offset(unit);
      if ((unit >>> 8) & 1) {
        const start = this.trie[node]! & 0x7fffffff;
        const end = this.normalized.indexOf(0, start);
        return this.normalized.subarray(start, end < 0 ? undefined : end).toString("utf8");
      }
    }
    return null;
  }
  normalize(text: string): string {
    let out = "";
    for (const { segment } of graphemes.segment(text)) {
      if (Buffer.byteLength(segment) < 6) {
        const whole = this.transform(segment);
        if (whole !== null) { out += whole; continue; }
      }
      for (const c of segment) out += this.transform(c) ?? c;
    }
    return out;
  }
}

export class UnigramTokenizer {
  private ids = new Map<string, number>();
  private scores: Float64Array;
  private unknown: number;
  private charsmap: Charsmap;
  constructor(json: string) {
    const file = JSON.parse(json) as { model: { type: string; unk_id: number; vocab: [string, number][] }; normalizer: { normalizers: { precompiled_charsmap?: string }[] } };
    if (file.model.type !== "Unigram" || file.model.unk_id !== 3 || file.model.vocab.length <= 250001) throw new Error("tokenizer");
    this.scores = new Float64Array(file.model.vocab.length);
    let min = Infinity;
    file.model.vocab.forEach(([piece, score], i) => { this.ids.set(piece, i); this.scores[i] = score; min = Math.min(min, score); });
    this.unknown = min - 10;
    const map = file.normalizer.normalizers.find(n => n.precompiled_charsmap)?.precompiled_charsmap;
    if (!map) throw new Error("tokenizer");
    this.charsmap = new Charsmap(Buffer.from(map, "base64"));
  }
  private word(word: string, out: number[]) {
    const chars = [...word];
    const best: { score: number; start: number; id: number; set: boolean }[] = Array.from({ length: chars.length + 1 }, () => ({ score: 0, start: 0, id: 0, set: false }));
    for (let start = 0; start < chars.length; start++) {
      const here = best[start]!.score;
      let single = false, piece = "";
      for (let end = start; end < Math.min(chars.length, start + 16); end++) {
        piece += chars[end];
        const id = this.ids.get(piece);
        if (id === undefined) continue;
        const score = here + this.scores[id]!, node = best[end + 1]!;
        if (!node.set || score > node.score) Object.assign(node, { score, start, id, set: true });
        if (end === start) single = true;
      }
      if (!single) {
        const score = here + this.unknown, node = best[start + 1]!;
        if (!node.set || score > node.score) Object.assign(node, { score, start, id: 3, set: true });
      }
    }
    const reversed: number[] = [];
    for (let end = chars.length; end > 0; end = best[end]!.start) {
      const { id } = best[end]!;
      if (!(id === 3 && reversed.at(-1) === 3)) reversed.push(id);
    }
    out.push(...reversed.reverse());
  }
  private segment(text: string, out: number[]) {
    let t = this.charsmap.normalize(text);
    while (t.includes("  ")) t = t.replaceAll("  ", " ");
    t = t.replaceAll(" ", "▁");
    if (!t) return;
    if (!t.startsWith("▁")) t = "▁" + t;
    let start = 0;
    for (let i = t.indexOf("▁", 1); i > 0; i = t.indexOf("▁", i + 1)) { this.word(t.slice(start, i), out); start = i; }
    this.word(t.slice(start), out);
  }
  encode(text: string): number[] {
    const out = [0];
    let rest = text;
    for (;;) {
      let found: [number, string, number] | null = null;
      for (const [token, id] of SPECIAL) {
        const at = rest.indexOf(token);
        if (at >= 0 && (!found || at < found[0] || (at === found[0] && token.length > found[1].length))) found = [at, token, id];
      }
      if (!found) break;
      this.segment(rest.slice(0, found[0]), out);
      out.push(found[2]);
      rest = rest.slice(found[0] + found[1].length);
    }
    this.segment(rest, out);
    out.push(2);
    return out;
  }
}
