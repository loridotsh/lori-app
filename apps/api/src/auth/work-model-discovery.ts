import { metadataPricing, publishedPricing, type WorkPricing } from "../cloud/pricing.js";
import { createHash } from "node:crypto";
import { extractLimits, type LimitTarget } from "../cloud/model-limit-discovery.js";
import { publishedModelLimits } from "../cloud/model-limits.js";

export type WorkModelCategory = "chat" | "image" | "video" | "other";
export interface WorkDiscoveredModel {
  id: string;
  name: string;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  workPricing?: WorkPricing;
  pricing?: { prompt?: number; completion?: number; cacheRead?: number; cacheWrite?: number };
  /** Set only by listings that type their models; the absence of a category means an ordinary chat listing. */
  category?: WorkModelCategory;
  /** False when Cloud Work cannot run the model: chat needs tools; images and videos are generated directly. */
  runsInWork?: boolean;
  /** Display price for models billed per image, second or video token instead of per million tokens. */
  unitPrice?: string;
  /** The clip length a video model defaults to; 0G requires one on every request. */
  videoSeconds?: number;
  /** Set only by listings that declare it. False means a request with an image is refused. */
  imageInput?: boolean;
}
/** The model's own default, then a length every current model accepts. */
function zeroGVideoSeconds(entry: Record<string, unknown>): number {
  const controls = (entry.video_capabilities as { controls?: unknown } | undefined)?.controls;
  const control = Array.isArray(controls)
    ? (controls as { key?: unknown; default?: unknown }[]).find((item) => item?.key === "seconds")
    : undefined;
  return typeof control?.default === "number" && control.default > 0 ? control.default : 5;
}
const ZERO_G_CATEGORIES = new Map<unknown, WorkModelCategory>([["chatbot", "chat"], ["text-to-image", "image"], ["video-generation", "video"]]);
const ZERO_G_UNITS = new Map<unknown, { label: string; scale: number }>([
  ["image", { label: "image", scale: 1 }],
  ["video_second", { label: "second", scale: 1 }],
  ["video_token", { label: "1M video tokens", scale: 1e6 }],
]);
function zeroGUnitPrice(entry: Record<string, unknown>): string | undefined {
  const prices = entry.pricing_usd as { image?: unknown; variants?: unknown } | undefined;
  if (!prices || typeof prices !== "object") return undefined;
  const listed: { unit?: unknown; unit_price?: unknown }[] = Array.isArray(prices.variants) ? prices.variants : [];
  const options = [...listed, { unit: "image", unit_price: prices.image }].flatMap((option) => {
    const unit = ZERO_G_UNITS.get(option?.unit);
    const amount = typeof option?.unit_price === "string" && option.unit_price.trim() ? Number(option.unit_price) : NaN;
    return unit && Number.isFinite(amount) && amount >= 0 ? [{ label: unit.label, amount: amount * unit.scale }] : [];
  });
  if (!options.length) return undefined;
  const lowest = options.reduce((best, option) => option.amount < best.amount ? option : best);
  return `${options.some((option) => option.amount !== lowest.amount) ? "From " : ""}$${Number(lowest.amount.toFixed(6))} per ${lowest.label}`;
}
const MAX_BYTES = 8 * 1024 * 1024;
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 160 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
function containsSecret(value: unknown, key: string): boolean {
  if (!key) return false;
  if (typeof value === "string") return value.includes(key);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => k.includes(key) || containsSecret(v, key));
}
/** Only selected metadata crosses the API boundary; never upstream error text or credentials. */
export function modelMetadata(entry: Record<string, unknown>, providerId: string): WorkDiscoveredModel | null {
  const rawId = entry.id ?? entry.name;
  const id = typeof rawId === "string" && providerId === "google" ? rawId.replace(/^models\//, "") : rawId;
  if (!validId(id)) return null;
  const methods = entry.supportedGenerationMethods;
  if (Array.isArray(methods) && !methods.includes("generateContent")) return null;
  const limits = extractLimits(entry);
  const published = publishedModelLimits(providerId, id);
  const rawName = entry.display_name ?? entry.displayName ?? entry.name;
  const name = typeof rawName === "string" && rawName.length <= 512 && !/[\u0000-\u001f\u007f]/.test(rawName) ? rawName : id;
  const model: WorkDiscoveredModel = { id, name };
  model.workPricing = metadataPricing(providerId, entry) ?? publishedPricing(providerId, id);
  if (providerId === "0g") {
    model.category = ZERO_G_CATEGORIES.get(entry.type) ?? "other";
    model.runsInWork = model.category === "image" || model.category === "video" ||
      (model.category === "chat" && Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools"));
    const unitPrice = zeroGUnitPrice(entry);
    if (unitPrice) model.unitPrice = unitPrice;
    if (model.category === "video") model.videoSeconds = zeroGVideoSeconds(entry);
    const inputs = (entry.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
    if (Array.isArray(inputs)) model.imageInput = inputs.includes("image");
  }
  if (limits.context) model.context_length = limits.context;
  if (limits.input) model.max_input_tokens = limits.input;
  if (limits.output) model.max_output_tokens = limits.output;
  if (!limits.context && !limits.input && published) model.context_length = published[0];
  if (!limits.output && published) model.max_output_tokens = published[1];
  // Pricing fields below are documented USD per token, not per million tokens.
  if (providerId === "openrouter" && entry.pricing && typeof entry.pricing === "object") {
    const prices = entry.pricing as Record<string, unknown>;
    const pricing: NonNullable<WorkDiscoveredModel["pricing"]> = {};
    for (const [source, dest] of [["prompt", "prompt"], ["completion", "completion"], ["input_cache_read", "cacheRead"], ["input_cache_write", "cacheWrite"]] as const) {
      const raw = prices[source];
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (Number.isFinite(value) && value >= 0) pricing[dest] = value;
    }
    if (Object.keys(pricing).length) model.pricing = pricing;
  }
  if (model.workPricing) model.pricing = { prompt: model.workPricing.input === undefined ? undefined : model.workPricing.input / 1e6, completion: model.workPricing.output === undefined ? undefined : model.workPricing.output / 1e6, cacheRead: model.workPricing.cacheRead === undefined ? undefined : model.workPricing.cacheRead / 1e6, cacheWrite: model.workPricing.cacheWrite === undefined ? undefined : model.workPricing.cacheWrite / 1e6 };
  return model;
}
export async function discoverWorkModels(target: LimitTarget, fetcher: typeof fetch = fetch): Promise<WorkDiscoveredModel[]> {
  const base = target.upstreamBaseUrl.replace(/\/+$/, "");
  const anthropic = target.protocol === "anthropic";
  const google = target.providerId === "google";
  const root = anthropic ? `${base.replace(/\/v1$/, "")}/v1/models` : google ? `${base.replace(/\/openai$/, "")}/models` : `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (anthropic) Object.assign(headers, { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" });
  else if (google) headers["x-goog-api-key"] = target.apiKey;
  else headers.authorization = `Bearer ${target.apiKey}`;
  const result = new Map<string, WorkDiscoveredModel>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  const signal = AbortSignal.timeout(10_000);
  for (let page = 0; page < 20; page++) {
    const url = new URL(root);
    if (anthropic) url.searchParams.set("limit", "100");
    if (google) url.searchParams.set("pageSize", "1000");
    if (cursor) url.searchParams.set(anthropic ? "after_id" : "pageToken", cursor);
    const response = await fetcher(url, { headers, redirect: "manual", signal });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("Model discovery unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Model list too large"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!body || typeof body !== "object" || containsSecret(body, target.apiKey)) throw new Error("Invalid model list");
    const entries = Array.isArray(body) ? body : body.data ?? body.models;
    if (!Array.isArray(entries)) throw new Error("Invalid model list");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const model = modelMetadata(entry, target.providerId);
      if (model) result.set(model.id, model);
      if (result.size > 5000) throw new Error("Too many models");
    }
    const next = anthropic && body.has_more ? body.last_id : google ? body.nextPageToken : undefined;
    if (anthropic && body.has_more && !next) throw new Error("Invalid model cursor");
    if (!next) return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (typeof next !== "string" || next.length > 4096 || seen.has(next)) throw new Error("Invalid model cursor");
    seen.add(next); cursor = next;
  }
  throw new Error("Too many model pages");
}

/**
 * 0G's model listing is public, so a successful listing says nothing about the key.
 * An unknown model is refused before any inference, so this costs nothing; only an
 * explicit credential refusal counts, since a valid key is answered with a model error.
 */
export async function listingKeyAccepted(target: LimitTarget, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (target.providerId !== "0g") return true;
  const response = await fetcher(`${target.upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "lori-key-check", messages: [{ role: "user", content: "." }], max_tokens: 1 }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status !== 401 && response.status !== 403;
}

// Route- and credential-scoped cache: never share private model availability across accounts.
// A failed listing is remembered briefly so each run round does not wait on a broken upstream again.
const FOUND_TTL_MS = 300_000;
const MISS_TTL_MS = 60_000;
const cache = new Map<string, { until: number; promise: Promise<WorkDiscoveredModel[]> }>();
export function cachedWorkModels(target: LimitTarget, fetcher: typeof fetch = fetch): Promise<WorkDiscoveredModel[]> {
  const key = createHash("sha256").update(JSON.stringify([target.providerId, target.protocol, target.upstreamBaseUrl, target.apiKey])).digest("hex");
  const entry = cache.get(key);
  if (entry && entry.until > Date.now()) return entry.promise;
  for (const [id, value] of cache) if (value.until <= Date.now()) cache.delete(id);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const promise = discoverWorkModels(target, fetcher).catch(() => {
    const failed = cache.get(key);
    if (failed?.promise === promise) failed.until = Math.min(failed.until, Date.now() + MISS_TTL_MS);
    return [];
  });
  cache.set(key, { until: Date.now() + FOUND_TTL_MS, promise });
  return promise;
}

/**
 * Providers whose listing says which models are chat models and which call tools,
 * so every model it offers can be enabled safely. A bare listing would also enable
 * embedding and speech models, which fail in a Work run.
 */
export const MODEL_SYNC_PROVIDERS: readonly string[] = ["0g"];
export const supportsModelSync = (providerId: string) => MODEL_SYNC_PROVIDERS.includes(providerId);
const MAX_SYNCED_MODELS = 512;
export const syncableModelIds = (models: readonly WorkDiscoveredModel[]) =>
  models
    .filter((model) => model.runsInWork === true && model.id.length <= 128)
    // Chat first: the first allowed model is what a new conversation starts on.
    .sort((a, b) => Number(a.category !== "chat") - Number(b.category !== "chat"))
    .map((model) => model.id)
    .slice(0, MAX_SYNCED_MODELS);

/** Providers whose model listing documents prices (see `metadataPricing`). */
const PRICED_LISTINGS = new Set(["0g", "openrouter", "together", "venice"]);
/** A priced listing also publishes limits, so one fetch answers for every model. */
export const listsModelLimits = (providerId: string) => PRICED_LISTINGS.has(providerId);

export async function resolveWorkPricing(target: LimitTarget & { workModelPricing?: Record<string, WorkPricing> }, model: string): Promise<WorkPricing | null> {
  const override = target.workModelPricing && Object.hasOwn(target.workModelPricing, model) ? target.workModelPricing[model] : undefined;
  if (override) return override;
  if (PRICED_LISTINGS.has(target.providerId)) {
    const found = (await cachedWorkModels(target)).find((m) => m.id === model)?.workPricing;
    if (found) return found;
  }
  return publishedPricing(target.providerId, model) ?? null;
}
