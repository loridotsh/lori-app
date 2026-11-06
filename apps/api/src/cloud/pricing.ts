import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CloudReportedUsage } from "@lori-enterprise/contracts";
const rate = z.number().finite().min(0).max(1_000_000).optional();
const rateShape = { input: rate, output: rate, cacheRead: rate, cacheWrite: rate, cacheWrite1h: rate };
export const WorkPricingSchema = z.object({
  ...rateShape,
  longContext: z.object({ above: z.number().int().positive().max(4_000_000), ...rateShape }).strict().optional(),
  source: z.string().min(1).max(512), version: z.string().min(1).max(100),
  currency: z.literal("USD"), unit: z.literal("perMillionTokens"),
}).strict();
export type WorkPricing = z.infer<typeof WorkPricingSchema>;
const catalog = z.record(z.string(), WorkPricingSchema).parse(JSON.parse(readFileSync(new URL("../../catalog/work-pricing.json", import.meta.url), "utf8")));
export const publishedPricing = (provider: string, model: string): WorkPricing | undefined =>
  Object.hasOwn(catalog, `${provider}:${model}`) ? structuredClone(catalog[`${provider}:${model}`]) : undefined;
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? v : undefined;
/** Provider-specific units only. Unknown gateways may explicitly expose Lori's USD/M contract. */
export function metadataPricing(provider: string, entry: Record<string, unknown>): WorkPricing | undefined {
  const explicit = WorkPricingSchema.safeParse(entry.workPricing);
  if (explicit.success) return explicit.data;
  // 0G's `pricing` field is in neuron, its on-chain unit; `pricing_usd` is USD per token.
  const p = (provider === "0g" ? entry.pricing_usd : entry.pricing ?? (entry.model_spec as { pricing?: unknown } | undefined)?.pricing) as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const value = (v: unknown, scale = 1) => number((typeof v === "string" && v.trim() ? Number(v) : typeof v === "number" ? v : NaN) * scale);
  let rates: Partial<WorkPricing> = {};
  if (provider === "openrouter") rates = { input: value(p.prompt, 1e6), output: value(p.completion, 1e6), cacheRead: value(p.input_cache_read, 1e6), cacheWrite: value(p.input_cache_write, 1e6) };
  else if (provider === "0g") rates = { input: value(p.prompt, 1e6), output: value(p.completion, 1e6), cacheWrite: value(p.cache_write, 1e6), cacheWrite1h: value(p.cache_write_1h, 1e6) };
  else if (provider === "together") rates = { input: value(p.input), output: value(p.output), cacheRead: value(p.cached_input) };
  else if (provider === "venice") {
    const usd = (key: string) => value((p[key] as { usd?: unknown } | undefined)?.usd);
    rates = { input: usd("input"), output: usd("output"), cacheRead: usd("cache_input") };
  }
  if (!Object.values(rates).some((value) => typeof value === "number")) return undefined;
  return { ...rates, source: `${provider}:models`, version: new Date().toISOString(), currency: "USD", unit: "perMillionTokens" };
}
export interface PricedUsage extends CloudReportedUsage { pricingSnapshot?: WorkPricing | null; estimatedCostMicrousd?: number | null; costCoveredTokens?: number; }
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function priceUsage(usage: PricedUsage, snapshot: WorkPricing | null | undefined = usage.pricingSnapshot): PricedUsage {
  const read = count(usage.cacheReadTokens), write = count(usage.cacheWriteTokens);
  const input = count(usage.uncachedInputTokens) ?? ((read ?? 0) === 0 ? count(usage.inputTokens) : null);
  const output = count(usage.outputTokens);
  const total = (input ?? 0) + (output ?? 0) + (read ?? 0) + (write ?? 0);
  const reported = count(usage.costMicrousd);
  if (reported !== null && Number.isSafeInteger(total)) return { ...usage, pricingSnapshot: snapshot ?? null, estimatedCostMicrousd: reported, costCoveredTokens: total };
  const parsed = WorkPricingSchema.safeParse(snapshot);
  if (!parsed.success) return { ...usage, pricingSnapshot: null, estimatedCostMicrousd: null, costCoveredTokens: 0 };
  const pricing = parsed.data;
  const prompt = input === null ? null : input + (read ?? 0) + (write ?? 0);
  if (pricing.longContext && prompt === null) return { ...usage, pricingSnapshot: pricing, estimatedCostMicrousd: null, costCoveredTokens: 0 };
  const rates = pricing.longContext && prompt! > pricing.longContext.above ? { ...pricing, ...pricing.longContext } : pricing;
  let oneHour = count(usage.cacheWrite1hTokens);
  let fiveMinute = count(usage.cacheWrite5mTokens);
  const hasDuration = oneHour !== null || fiveMinute !== null;
  if (write !== null) {
    if (oneHour !== null && fiveMinute === null && oneHour <= write) fiveMinute = write - oneHour;
    if (fiveMinute !== null && oneHour === null && fiveMinute <= write) oneHour = write - fiveMinute;
  }
  const split = write !== null && oneHour !== null && fiveMinute !== null && oneHour + fiveMinute === write;
  // Contradictory duration reports cannot safely be priced at the cheaper base rate.
  const components = [[input,rates.input],[output,rates.output],[read,rates.cacheRead],
    ...(split ? [[fiveMinute,rates.cacheWrite],[oneHour,rates.cacheWrite1h]] : hasDuration ? [] : [[write,rates.cacheWrite]])];
  let cost = 0, covered = 0, known = false;
  for (const [tokens, rate] of components) if (tokens !== null && tokens !== undefined && rate !== undefined && rate !== null) { cost += tokens * rate; covered += tokens; known = true; }
  const rounded = Math.round(cost);
  return { ...usage, pricingSnapshot: pricing, estimatedCostMicrousd: known && Number.isSafeInteger(rounded) && Number.isSafeInteger(covered) ? rounded : null, costCoveredTokens: Number.isSafeInteger(rounded) && Number.isSafeInteger(covered) ? covered : 0 };
}
