import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, type Chunk, type Probe } from "./ranking.js";

const QUERY_DEADLINE_MS = 1500;
const PASSAGE_DEADLINE_MS = 60_000;
const IDLE_MS = 15 * 60_000;
const MAX_QUERIES = 16;
const MAX_PASSAGES = 8;
const CACHE_SIZE = 512;
const CACHE_TTL_MS = 10 * 60_000;

type Pending = { resolve: (value: unknown) => void; timer: NodeJS.Timeout; op: "query" | "passage" };

/**
 * Local multilingual embeddings in one supervised child process. Never blocks a
 * database transaction: callers embed before a transaction and read the cache
 * inside it. Every failure resolves to null so retrieval falls back to lexical.
 */
export class SemanticEmbedder {
  private child?: ChildProcess;
  private ready?: Promise<boolean>;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private cache = new Map<string, { probe: Probe; at: number }>();
  private failures = 0;
  private openUntil = 0;
  private idle?: NodeJS.Timeout;
  private stopped = new WeakSet<ChildProcess>();
  readonly directory: string;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.directory = env.LORI_SEMANTIC_MODEL_DIR || fileURLToPath(new URL(`../../../semantic/model/${manifest.id}/`, import.meta.url));
  }

  get model() { return manifest.id; }

  /** Kill switch plus a cheap check that the pinned assets are present; integrity is verified by the child. */
  get available() {
    if (["off", "0", "false"].includes((this.env.LORI_SEMANTIC_MEMORY ?? "").trim())) return false;
    return Object.entries(manifest.files).every(([name, f]) => {
      try { return statSync(join(this.directory, name.split("/").at(-1)!)).size === f.size; } catch { return false; }
    });
  }

  private key(text: string) {
    return createHash("sha256").update(manifest.id).update("\0").update(text).digest("hex");
  }

  /** Synchronous cache read for use inside a transaction. */
  peek(text: string): Probe | null {
    const value = text.trim().slice(0, 4000);
    if (!value) return null;
    const hit = this.cache.get(this.key(value));
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.probe : null;
  }

  async query(text: string): Promise<Probe | null> {
    const value = text.trim().slice(0, 4000);
    if (!value) return null;
    const cached = this.peek(value);
    if (cached) return cached;
    const result = await this.request("query", { text: value }, QUERY_DEADLINE_MS) as { vector: Float32Array; floor: number } | null;
    if (!result || !(result.vector instanceof Float32Array) || result.vector.length !== manifest.dimensions || !Number.isFinite(result.floor)) return null;
    const probe = { vector: result.vector, floor: result.floor };
    const key = this.key(value);
    this.cache.delete(key);
    this.cache.set(key, { probe, at: Date.now() });
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return probe;
  }

  async passage(header: string, body: string): Promise<Chunk[] | null> {
    if (!body.trim()) return [];
    const result = await this.request("passage", { header, body }, PASSAGE_DEADLINE_MS) as { chunks: Chunk[] } | null;
    if (!result || !Array.isArray(result.chunks) || result.chunks.some(c => !(c.vector instanceof Float32Array) || c.vector.length !== manifest.dimensions)) return null;
    return result.chunks;
  }

  private async request(op: "query" | "passage", payload: Record<string, string>, deadline: number): Promise<unknown> {
    if (!this.available || Date.now() < this.openUntil) return null;
    const count = [...this.pending.values()].filter(p => p.op === op).length;
    if (count >= (op === "query" ? MAX_QUERIES : MAX_PASSAGES)) return null;
    const expires = Date.now() + deadline;
    let startupTimer: NodeJS.Timeout | undefined;
    const started = await Promise.race([
      this.start(),
      new Promise<boolean>(resolve => { startupTimer = setTimeout(() => resolve(false), deadline); }),
    ]).finally(() => clearTimeout(startupTimer));
    if (!started || Date.now() >= expires) return null;
    const child = this.child;
    if (!child?.connected) return null;
    const id = ++this.sequence;
    this.touch();
    const value = await new Promise<unknown>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, expires - Date.now());
      this.pending.set(id, { resolve, timer, op });
      try { child.send({ id, op, ...payload, deadline: expires }); } catch { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
    if (value) this.failures = 0;
    else if (++this.failures >= 3) { this.failures = 0; this.openUntil = Date.now() + 60_000; }
    return value;
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    const source = import.meta.url.endsWith(".ts");
    const inherited = process.execArgv.filter(a => !a.startsWith("--max-old-space-size") && !a.startsWith("--inspect"));
    const loader = source && !inherited.some(a => a.includes("tsx")) ? ["--import", import.meta.resolve("tsx")] : [];
    const child = fork(fileURLToPath(new URL(`./worker.${source ? "ts" : "js"}`, import.meta.url)), [], {
      serialization: "advanced",
      execArgv: [...inherited, ...loader, "--max-old-space-size=384"],
      env: { PATH: this.env.PATH ?? "", NODE_ENV: this.env.NODE_ENV ?? "production", LORI_SEMANTIC_MODEL_DIR: this.directory, LORI_SEMANTIC_THREADS: this.env.LORI_SEMANTIC_THREADS ?? "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.ready = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { resolve(false); child.kill(); }, 120_000);
      child.on("message", (message: { ready?: boolean; id?: number; ok?: boolean }) => {
        if (message.ready) { clearTimeout(timer); resolve(true); return; }
        const pending = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id!);
        pending.resolve(message.ok ? message : null);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
        if (this.child === child) { this.child = undefined; this.ready = undefined; }
        for (const [id, p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); p.resolve(null); }
        if (!this.stopped.has(child)) this.openUntil = Math.max(this.openUntil, Date.now() + 30_000);
      });
      child.on("error", () => child.kill());
    });
    child.unref();
    (child.channel as { unref?: () => void } | undefined)?.unref?.();
    return this.ready;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.pending.size) this.close(); }, IDLE_MS);
    this.idle.unref();
  }

  close() {
    if (this.child) this.stopped.add(this.child);
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}
