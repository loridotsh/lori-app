import { createHash } from "node:crypto";
/**
 * Finds a model's real context window instead of guessing from its name.
 *
 * Providers publish limits in different places and under different names, so
 * each is asked where it documents them. Results are cached, a failure never
 * blocks a run (the next source in the order below answers instead), and a
 * provider's own "context too long" error teaches a lower ceiling.
 *
 * Order: operator override, learned ceiling, provider metadata, reviewed
 * published table, family estimate, conservative default.
 */
import {
  estimateModelLimits,
  limitsFrom,
  MAX_RESPONSE_TOKENS,
  responseCeiling,
  zeroGUnlistedOutput,
  type ModelLimitOverrides,
  type ModelLimits,
} from "./model-limits.js";

export interface LimitTarget {
  providerId: string;
  protocol: "openai" | "anthropic";
  upstreamBaseUrl: string;
  apiKey: string;
}

interface Found {
  /** Total window, when the provider reports one. */
  context?: number;
  /** Largest prompt, when reported separately from the window. */
  input?: number;
  output?: number;
  /** Set for image and video models, which generate media instead of chatting. */
  media?: ModelMedia;
}

export interface ModelMedia {
  kind: "image" | "video";
  price?: string;
}

/**
 * Image and video prompts carry no conversation history, so a long chat must not
 * be refused on their behalf. This is only the planning window for that round.
 */
const MEDIA_WINDOW = 1_000_000;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FOUND = 8192;
const MIN_WINDOW = 2048;
const MAX_WINDOW = 4_000_000;

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
const at = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );
const first = (value: unknown, paths: string[][]) =>
  paths.map((path) => positive(at(value, path))).find((n) => n !== undefined);
const smaller = (a?: number, b?: number) =>
  a !== undefined && b !== undefined ? Math.min(a, b) : (a ?? b);

/**
 * Reads the documented limit fields providers use. A gateway can expose a
 * smaller limit for the route it selects, so the smaller figure wins, and
 * separate input and output limits are never merged into one invented window.
 */
export function extractLimits(entry: unknown): Found {
  const context = smaller(
    first(entry, [
      ["context_length"],
      ["context_window"],
      ["max_context_length"],
      ["max_model_len"],
      ["contextLength"],
      ["model_spec", "availableContextTokens"],
    ]),
    first(entry, [["top_provider", "context_length"]]),
  );
  const input = first(entry, [["max_input_tokens"], ["inputTokenLimit"]]);
  const output = smaller(
    first(entry, [
      ["max_output_tokens"],
      ["max_completion_tokens"],
      ["outputTokenLimit"],
      ["max_tokens"],
    ]),
    first(entry, [["top_provider", "max_completion_tokens"]]),
  );
  return {
    ...(context !== undefined ? { context } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/** The entry for one model in a single-model reply or a `{data|models: [...]}` listing. */
export function modelEntry(body: unknown, modelId: string): unknown {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const listing = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(body)
        ? (body as unknown[])
        : undefined;
  const names = (item: unknown) =>
    [at(item, ["id"]), at(item, ["name"]), at(item, ["model"])].filter(
      (value): value is string => typeof value === "string",
    );
  if (listing)
    return listing.find((item) => {
      const found = names(item);
      return found.includes(modelId) || found.includes(`models/${modelId}`);
    });
  const single = names(body);
  return single.length === 0 ||
    single.includes(modelId) ||
    single.includes(`models/${modelId}`)
    ? body
    : undefined;
}

/**
 * Where each provider documents a model's limits. Every URL is built from the
 * catalog's fixed upstream origin, never from anything a member supplied, and
 * the API key is only ever sent to that same origin.
 */
function requests(
  target: LimitTarget,
  modelId: string,
): { url: string; headers: Record<string, string> }[] {
  const base = target.upstreamBaseUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(modelId);
  const bearer = { authorization: `Bearer ${target.apiKey}` };
  switch (target.providerId) {
    case "openai":
      return []; // The Models API reports no context field.
    case "anthropic":
      return [
        {
          url: `${base.replace(/\/v1$/, "")}/v1/models/${encoded}`,
          headers: { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" },
        },
      ];
    case "google":
      // The OpenAI-compatible route has no limits; the native model resource does.
      return [
        {
          url: `${base.replace(/\/openai$/, "")}/models/${encoded}`,
          headers: { "x-goog-api-key": target.apiKey },
        },
      ];
    case "fireworks": {
      const parts = modelId.split("/");
      if (parts.length !== 4 || parts[0] !== "accounts" || parts[2] !== "models") return [];
      if (parts.some((part) => !part || part === "." || part === "..")) return [];
      const origin = new URL(base).origin;
      // The model's own resource, then the inference listing, which also publishes context_length.
      return [
        { url: `${origin}/v1/${parts.map(encodeURIComponent).join("/")}`, headers: bearer },
        { url: `${base}/models`, headers: bearer },
      ];
    }
    case "groq":
    case "mistral":
      return [{ url: `${base}/models/${encoded}`, headers: bearer }];
    default:
      // OpenAI-compatible gateways list their models, with limits where they publish any.
      return [{ url: `${base}/models`, headers: bearer }];
  }
}

/** Numbers a provider quotes when it refuses a request for being too long. */
const OVERFLOW_PATTERNS = [
  /maximum context length is (\d[\d,]*)/i,
  /context (?:window|length) (?:of|is) (\d[\d,]*)/i,
  /(?:>|exceeds?|limit of|limit is|maximum of|max(?:imum)? is) (\d[\d,]*)(?: tokens?)?(?: maximum| limit)?/i,
];

/** Whether a provider refused the requested reply budget, not the prompt. */
export const refusesOutputBudget = (body: string): boolean =>
  /max[_ ]?(?:completion[_ ]|output[_ ])?tokens/i.test(body);

/** The largest limit a budget refusal names, or the ceiling known to work everywhere. */
export function outputCeilingFromRefusal(body: string, requested: number): number {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // A plain-text refusal is read as it is.
  }
  const named = [...message.matchAll(/\d[\d,]*/g)]
    .map((match) => Number(match[0].replaceAll(",", "")))
    .filter((value) => Number.isInteger(value) && value >= 1024 && value < requested);
  return named.length ? Math.max(...named) : Math.min(MAX_RESPONSE_TOKENS, requested - 1);
}

/** The window a provider's "too long" message names, or null when it names none we can trust. */
export function ceilingFromRefusal(body: string): number | null {
  for (const pattern of OVERFLOW_PATTERNS) {
    const match = pattern.exec(body);
    const value = match ? Number(match[1]!.replaceAll(",", "")) : NaN;
    if (Number.isInteger(value) && value >= MIN_WINDOW && value <= MAX_WINDOW)
      return value;
  }
  return null;
}

export class ModelLimitResolver {
  private readonly found = new Map<string, { at: number; value: Found | null }>();
  private readonly learned = new Map<string, number>();
  private readonly learnedOutput = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<Found | null>>();
  private readonly primedAt = new Map<string, number>();

  constructor(
    private readonly overrides: ModelLimitOverrides = {},
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  private key = (providerId: string, modelId: string, target?: LimitTarget) =>
    `${providerId}\0${modelId}\0${target ? createHash("sha256").update(JSON.stringify([target.upstreamBaseUrl, target.apiKey])).digest("hex") : "public"}`;

  /** What is known without asking anyone: for listings and as a fallback. */
  peek(providerId: string, modelId: string, target?: LimitTarget): ModelLimits {
    const base = estimateModelLimits(providerId, modelId, this.overrides);
    if (base.source === "override") return base;
    return this.apply(providerId, modelId, base, this.cached(providerId, modelId, target), target);
  }

  /** Records limits from one provider listing, so every model reads its real window without its own request. */
  prime(
    target: LimitTarget,
    models: readonly {
      id: string;
      context_length?: number;
      max_input_tokens?: number;
      max_output_tokens?: number;
      category?: string;
      unitPrice?: string;
    }[],
  ): void {
    if (models.length > 0) {
      if (this.primedAt.size >= MAX_FOUND) this.primedAt.delete(this.primedAt.keys().next().value!);
      this.primedAt.set(this.key(target.providerId, "", target), this.now());
    }
    for (const model of models) {
      if (model.category === "image" || model.category === "video") {
        this.remember(this.key(target.providerId, model.id, target), {
          context: MEDIA_WINDOW,
          media: { kind: model.category, ...(model.unitPrice ? { price: model.unitPrice } : {}) },
        });
        continue;
      }
      const value: Found = {
        ...(model.context_length ? { context: model.context_length } : {}),
        ...(model.max_input_tokens ? { input: model.max_input_tokens } : {}),
        ...(model.max_output_tokens ? { output: model.max_output_tokens } : {}),
      };
      const window = value.context ?? value.input;
      if (window === undefined || window < MIN_WINDOW || window > MAX_WINDOW) continue;
      this.remember(this.key(target.providerId, model.id, target), value);
    }
  }

  /** What a primed listing said this model generates, when it is not a chat model. */
  media(providerId: string, modelId: string, target?: LimitTarget): ModelMedia | undefined {
    return this.found.get(this.key(providerId, modelId, target))?.value?.media;
  }

  /** Remembers a lower reply limit a provider stated, so later requests start within it. */
  learnOutput(providerId: string, modelId: string, ceiling: number, target?: LimitTarget) {
    if (this.learnedOutput.size >= 1024) this.learnedOutput.delete(this.learnedOutput.keys().next().value!);
    this.learnedOutput.set(this.key(providerId, modelId, target), ceiling);
  }

  /** Known limits are still current, so a page can show them while a listing refreshes. */
  primed(target: LimitTarget): boolean {
    const at = this.primedAt.get(this.key(target.providerId, "", target));
    return at !== undefined && this.now() - at < FOUND_TTL_MS;
  }

  private remember(key: string, value: Found | null) {
    if (!this.found.has(key) && this.found.size >= MAX_FOUND)
      this.found.delete(this.found.keys().next().value!);
    this.found.set(key, { at: this.now(), value });
  }

  async resolve(target: LimitTarget, modelId: string): Promise<ModelLimits> {
    const base = estimateModelLimits(target.providerId, modelId, this.overrides);
    if (base.source === "override") return base;
    let discovered = this.cached(target.providerId, modelId, target);
    if (discovered === undefined) discovered = await this.discover(target, modelId);
    return this.apply(target.providerId, modelId, base, discovered, target);
  }

  /**
   * Remembers the window a provider named when it refused a request for being
   * too long, so the next attempt plans against the truth. Only a lower figure
   * is learned: a refusal can never raise a limit.
   */
  learn(providerId: string, modelId: string, refusal: string, target?: LimitTarget): number | null {
    const ceiling = ceilingFromRefusal(refusal);
    if (ceiling === null) return null;
    if (this.overrides[`${providerId}:${modelId}`]) return null;
    const current = this.peek(providerId, modelId, target).contextTokens;
    const key = this.key(providerId, modelId, target);
    if (ceiling >= current || ceiling >= (this.learned.get(key) ?? Infinity)) return null;
    if (this.learned.size >= 1024) this.learned.delete(this.learned.keys().next().value!);
    this.learned.set(key, ceiling);
    return ceiling;
  }

  private cached(providerId: string, modelId: string, target?: LimitTarget): Found | null | undefined {
    const entry = this.found.get(this.key(providerId, modelId, target));
    if (!entry) return undefined;
    const age = this.now() - entry.at;
    return age > (entry.value ? FOUND_TTL_MS : MISS_TTL_MS) ? undefined : entry.value;
  }

  private apply(
    providerId: string,
    modelId: string,
    base: ModelLimits,
    discovered: Found | null | undefined,
    target?: LimitTarget,
  ): ModelLimits {
    let limits = base;
    const ceiling = responseCeiling(providerId);
    if (discovered && (discovered.context || discovered.input)) {
      // 0G omits the reply limit for many large-window thinking models; the
      // default 4k would end their turns inside the reasoning trace.
      const unlisted =
        providerId === "0g" && discovered.context
          ? (zeroGUnlistedOutput(modelId) ??
            Math.max(base.outputTokens, Math.min(Math.floor(discovered.context / 16), MAX_RESPONSE_TOKENS)))
          : base.outputTokens;
      const reply = discovered.output ?? unlisted;
      const output = Math.min(reply, ceiling);
      // A prompt limit reported on its own leaves room for the reply on top.
      const window = Math.min(
        discovered.context ?? MAX_WINDOW,
        discovered.input !== undefined ? discovered.input + output : MAX_WINDOW,
      );
      limits = limitsFrom(window, reply, "provider", ceiling);
    } else if (discovered?.output) {
      limits = limitsFrom(base.contextTokens, discovered.output, "provider", ceiling);
    }
    const key = this.key(providerId, modelId, target);
    const learnedOutput = this.learnedOutput.get(key);
    if (learnedOutput !== undefined && learnedOutput < limits.outputTokens)
      limits = { ...limits, outputTokens: learnedOutput };
    const learned = this.learned.get(key);
    return learned !== undefined && learned < limits.contextTokens
      ? limitsFrom(learned, limits.outputTokens, "learned", ceiling)
      : limits;
  }

  private discover(target: LimitTarget, modelId: string): Promise<Found | null> {
    const key = this.key(target.providerId, modelId, target);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.fetchLimits(target, modelId)
      .catch(() => null)
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async fetchLimits(target: LimitTarget, modelId: string): Promise<Found | null> {
    for (const request of requests(target, modelId)) {
      const response = await this.fetcher(request.url, {
        method: "GET",
        headers: { accept: "application/json", ...request.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const length = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok || length > MAX_BODY_BYTES) {
        await response.body?.cancel();
        continue;
      }
      // Content-Length is optional and may describe compressed bytes. Enforce
      // the limit while consuming the decoded stream, before buffering it.
      if (!response.body) continue;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (size > MAX_BODY_BYTES) continue;
      const text = Buffer.concat(chunks, size).toString("utf8");
      // A reply that echoes the key is not metadata we should trust or keep.
      if (text.length > MAX_BODY_BYTES || (target.apiKey && text.includes(target.apiKey))) continue;
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        continue;
      }
      const limits = extractLimits(modelEntry(body, modelId));
      const window = limits.context ?? limits.input;
      if (window !== undefined && window >= MIN_WINDOW && window <= MAX_WINDOW)
        return limits;
      if (limits.output) return limits;
    }
    return null;
  }
}
