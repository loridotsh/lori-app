import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadataPricing, priceUsage, publishedPricing, type WorkPricing } from "./pricing.js";
const rates: WorkPricing = { input: 2, output: 10, cacheRead: .2, cacheWrite: 2.5, cacheWrite1h: 4, source: "configured", version: "test", currency: "USD", unit: "perMillionTokens" };
describe("Work pricing calculation", () => {
  it("prices input, output and cached input once and preserves its snapshot", () => {
    const priced = priceUsage({ inputTokens: 1000, uncachedInputTokens: 600, outputTokens: 50, cacheReadTokens: 400, reasoningTokens: 20 }, rates);
    expect(priced).toMatchObject({ estimatedCostMicrousd: 1780, costCoveredTokens: 1050 });
    expect(priced.pricingSnapshot).toEqual(rates);
  });
  it("uses reported cost first, including zero; partial and unknown rates remain honest", () => {
    expect(priceUsage({ inputTokens: 100, outputTokens: 20, costMicrousd: 0 }, rates)).toMatchObject({ estimatedCostMicrousd: 0, costCoveredTokens: 120 });
    expect(priceUsage({ inputTokens: 100, outputTokens: 20 }, { ...rates, output: undefined })).toMatchObject({ estimatedCostMicrousd: 200, costCoveredTokens: 100 });
    expect(priceUsage({ inputTokens: 100, outputTokens: 20 }, null)).toMatchObject({ estimatedCostMicrousd: null, costCoveredTokens: 0 });
  });
  it("prices separate 5-minute and 1-hour cache writes without counting them twice", () => {
    expect(priceUsage({ inputTokens: 100, uncachedInputTokens:100, outputTokens:10, cacheReadTokens:300, cacheWriteTokens:75, cacheWrite5mTokens:50, cacheWrite1hTokens:25 }, rates)).toMatchObject({ estimatedCostMicrousd:585, costCoveredTokens:485 });
  });
  it("uses exact official IDs and request-wide long-context tiers", () => {
    const luna = publishedPricing("openai","gpt-6-luna")!;
    expect(priceUsage({inputTokens:6857,outputTokens:13,cacheReadTokens:0},luna)).toMatchObject({estimatedCostMicrousd:692,costCoveredTokens:6870});
    expect(priceUsage({inputTokens:272001,outputTokens:100,cacheReadTokens:0},luna).estimatedCostMicrousd).toBe(54475);
    expect(publishedPricing("custom-openai","gpt-6-luna")).toBeUndefined();
    expect(publishedPricing("openai","my-gpt-6-luna")).toBeUndefined();
  });
  it("normalizes each provider's documented units and rejects ambiguous custom prices", () => {
    expect(metadataPricing("openrouter",{pricing:{prompt:"0.000002",completion:"0.00001"}})).toMatchObject({input:2,output:10});
    expect(metadataPricing("together",{pricing:{input:2,output:10}})).toMatchObject({input:2,output:10});
    expect(metadataPricing("0g",{pricing:{prompt:"8637872615374"},pricing_usd:{prompt:"0.000002",completion:"0.00001",cache_write:"0.000003",cache_write_1h:"0.000004"}})).toMatchObject({input:2,output:10,cacheWrite:3,cacheWrite1h:4});
    expect(metadataPricing("0g",{pricing:{prompt:"8637872615374"}})).toBeUndefined();
    expect(metadataPricing("venice",{model_spec:{pricing:{input:{usd:2},output:{usd:10}}}})).toMatchObject({input:2,output:10});
    expect(metadataPricing("custom",{pricing:{input:2,output:10}})).toBeUndefined();
    expect(metadataPricing("custom",{workPricing:rates})).toEqual(rates);
  });
  it("never estimates unknown counters or non-finite amounts", () => {
    expect(priceUsage({},rates).estimatedCostMicrousd).toBeNull();
    expect(priceUsage({inputTokens:100},{...rates,input:Infinity}).estimatedCostMicrousd).toBeNull();
    expect(priceUsage({inputTokens:Number.MAX_SAFE_INTEGER},rates).estimatedCostMicrousd).toBeNull();
  });
});

it("ships the same versioned rate catalog in Enterprise and the shared desktop/worker crate",()=>{
 const api=JSON.parse(readFileSync(new URL("../../catalog/work-pricing.json",import.meta.url),"utf8"));
 const shared=JSON.parse(readFileSync(new URL("../../../worker/vendor/work-provider/src/pricing.json",import.meta.url),"utf8"));
 expect(api).toEqual(shared);
});

it("inherits unchanged long-context rates and reconstructs partial write durations", () => {
  const tiered = { ...rates, longContext: { above: 100, input: 4 } };
  expect(priceUsage({ inputTokens: 200, outputTokens: 20 }, tiered)).toMatchObject({ estimatedCostMicrousd: 1000, costCoveredTokens: 220 });
  expect(priceUsage({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 75, cacheWrite1hTokens: 25 }, rates)).toMatchObject({ estimatedCostMicrousd: 525, costCoveredTokens: 185 });
  expect(priceUsage({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 75, cacheWrite1hTokens: 80 }, rates)).toMatchObject({ estimatedCostMicrousd: 300, costCoveredTokens: 110 });
  expect(priceUsage({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 75, cacheWrite1hTokens: 25, cacheWrite5mTokens: 60 }, rates)).toMatchObject({ estimatedCostMicrousd: 300, costCoveredTokens: 110 });
});
