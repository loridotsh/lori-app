import { describe, expect, it, vi } from "vitest";
import {
  ModelLimitResolver,
  ceilingFromRefusal,
  extractLimits,
  modelEntry,
  outputCeilingFromRefusal,
  refusesOutputBudget,
  type LimitTarget,
} from "./model-limit-discovery.js";
import { MAX_RESPONSE_TOKENS, estimateModelLimits, familyLimits } from "./model-limits.js";

const target = (providerId: string, upstreamBaseUrl: string, protocol: "openai" | "anthropic" = "openai"): LimitTarget => ({
  providerId,
  protocol,
  upstreamBaseUrl,
  apiKey: "sk-secret-key",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function resolver(reply: (url: string, init: RequestInit) => Response | Promise<Response>, overrides = {}) {
  let clock = 1_000_000;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => reply(url, init));
  return { fetcher, tick: (ms: number) => void (clock += ms), resolver: new ModelLimitResolver(overrides, fetcher, () => clock) };
}

describe("priming limits from one listing", () => {
  const zeroG = target("0g", "https://router-api.0g.ai/v1");

  it("gives every listed model its real window without a request per model", async () => {
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(zeroG, [
      { id: "gpt-6.1-terra", context_length: 922_000, max_output_tokens: 128_000 },
      { id: "claude-haiku-5.5", context_length: 1_000_000, max_output_tokens: 128_000 },
    ]);
    expect(t.resolver.peek("0g", "gpt-6.1-terra", zeroG)).toMatchObject({ contextTokens: 922_000, outputTokens: 32_768, source: "provider" });
    expect(t.resolver.peek("0g", "claude-haiku-5.5", zeroG).contextTokens).toBe(1_000_000);
    expect((await t.resolver.resolve(zeroG, "gpt-6.1-terra")).contextTokens).toBe(922_000);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("reports priming only after a listing returned models, and expires with the limits", () => {
    const t = resolver(() => json({ data: [] }));
    expect(t.resolver.primed(zeroG)).toBe(false);
    t.resolver.prime(zeroG, []);
    expect(t.resolver.primed(zeroG)).toBe(false);
    t.resolver.prime(zeroG, [{ id: "real", context_length: 500_000 }]);
    expect(t.resolver.primed(zeroG)).toBe(true);
    expect(t.resolver.primed({ ...zeroG, apiKey: "sk-other" })).toBe(false);
    t.tick(7 * 60 * 60 * 1000);
    expect(t.resolver.primed(zeroG)).toBe(false);
  });
  it("ignores a model with no usable window and never leaks between keys", () => {
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(zeroG, [{ id: "no-window" }, { id: "tiny", context_length: 10 }, { id: "real", context_length: 500_000 }]);
    expect(t.resolver.peek("0g", "no-window", zeroG).source).not.toBe("provider");
    expect(t.resolver.peek("0g", "tiny", zeroG).source).not.toBe("provider");
    expect(t.resolver.peek("0g", "real", { ...zeroG, apiKey: "sk-other" }).source).not.toBe("provider");
  });
  it("keeps an operator override above listed limits", () => {
    const t = resolver(() => json({ data: [] }), { "0g:real": { contextTokens: 64_000, outputTokens: 4_000 } });
    t.resolver.prime(zeroG, [{ id: "real", context_length: 500_000 }]);
    expect(t.resolver.peek("0g", "real", zeroG)).toMatchObject({ contextTokens: 64_000, source: "override" });
  });
  it("keeps a lower ceiling the provider taught through a refusal", () => {
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(zeroG, [{ id: "real", context_length: 500_000 }]);
    t.resolver.learn("0g", "real", "maximum context length is 200000 tokens", zeroG);
    expect(t.resolver.peek("0g", "real", zeroG).contextTokens).toBe(200_000);
  });
});

describe("0G limits", () => {
  const zeroG = target("0g", "https://router-api.0g.ai/v1");
  const listing = { data: [
    { id: "unlisted-large", context_length: 1_000_000 },
    { id: "unlisted-small", context_length: 32_768 },
    { id: "listed", context_length: 1_000_000, max_completion_tokens: 8_192 },
  ] };

  it("gives large models without a published reply limit room to finish thinking", async () => {
    const t = resolver(() => json(listing));
    expect(await t.resolver.resolve(zeroG, "unlisted-large")).toMatchObject({ contextTokens: 1_000_000, outputTokens: MAX_RESPONSE_TOKENS, source: "provider" });
  });
  it("keeps the conservative default on small windows", async () => {
    const t = resolver(() => json(listing));
    expect(await t.resolver.resolve(zeroG, "unlisted-small")).toMatchObject({ contextTokens: 32_768, outputTokens: 4_096 });
  });
  it("prefers the limit 0G publishes", async () => {
    const t = resolver(() => json(listing));
    expect(await t.resolver.resolve(zeroG, "listed")).toMatchObject({ outputTokens: 8_192 });
  });
  it("does not change the fallback for other providers", async () => {
    const t = resolver(() => json(listing));
    expect(await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "unlisted-large")).toMatchObject({ outputTokens: 4_096 });
  });
});

describe("extractLimits", () => {
  it("reads every documented field name", () => {
    expect(extractLimits({ context_length: 200_000, max_completion_tokens: 8_192 })).toEqual({ context: 200_000, output: 8_192 });
    expect(extractLimits({ context_window: 131_072 })).toEqual({ context: 131_072 });
    expect(extractLimits({ max_context_length: 128_000 })).toEqual({ context: 128_000 });
    expect(extractLimits({ contextLength: 65_536 })).toEqual({ context: 65_536 });
    expect(extractLimits({ model_spec: { availableContextTokens: 32_000 } })).toEqual({ context: 32_000 });
    expect(extractLimits({ max_input_tokens: 200_000, max_tokens: 64_000 })).toEqual({ input: 200_000, output: 64_000 });
    expect(extractLimits({ inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 })).toEqual({ input: 1_048_576, output: 65_536 });
  });
  it("prefers a gateway's smaller route limit and ignores nonsense", () => {
    expect(extractLimits({ context_length: 1_000_000, top_provider: { context_length: 200_000, max_completion_tokens: 16_000 }, max_tokens: 64_000 }))
      .toEqual({ context: 200_000, output: 16_000 });
    expect(extractLimits({ context_length: "big", max_tokens: -5, max_output_tokens: 1.5 })).toEqual({});
    expect(extractLimits(null)).toEqual({});
  });
});

describe("modelEntry", () => {
  it("finds a model in a listing, or accepts a single-model reply", () => {
    const listing = { data: [{ id: "a", context_length: 1 }, { id: "vendor/b", context_length: 2 }] };
    expect(modelEntry(listing, "vendor/b")).toEqual({ id: "vendor/b", context_length: 2 });
    expect(modelEntry(listing, "missing")).toBeUndefined();
    expect(modelEntry({ models: [{ name: "models/gem", inputTokenLimit: 9 }] }, "gem")).toMatchObject({ inputTokenLimit: 9 });
    expect(modelEntry({ id: "m", max_input_tokens: 5 }, "m")).toMatchObject({ max_input_tokens: 5 });
    expect(modelEntry({ id: "other" }, "m")).toBeUndefined();
  });
});

describe("0G reply limits", () => {
  const zeroG = target("0g", "https://router-api.0g.ai/v1");
  const primed = (models: Parameters<ModelLimitResolver["prime"]>[1]) => {
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(zeroG, models);
    return t.resolver;
  };

  it("uses the vendor's figure when 0G lists none, and the old estimate otherwise", () => {
    const limits = primed([{ id: "kimi-k2.6", context_length: 262_144 }, { id: "qwen-plus", context_length: 1_000_000 }]);
    expect(limits.peek("0g", "kimi-k2.6", zeroG).outputTokens).toBe(32_768);
    expect(limits.peek("0g", "qwen-plus", zeroG).outputTokens).toBe(MAX_RESPONSE_TOKENS);
  });
  it("prefers 0G's own figure and always leaves half the window for input", () => {
    const limits = primed([
      { id: "kimi-k2.6", context_length: 262_144, max_output_tokens: 20_000 },
      { id: "qwen-max", context_length: 32_768, max_output_tokens: 30_000 },
    ]);
    expect(limits.peek("0g", "kimi-k2.6", zeroG).outputTokens).toBe(20_000);
    expect(limits.peek("0g", "qwen-max", zeroG).outputTokens).toBe(16_384);
  });
  it("never asks for more than the stream can carry, whatever a model lists", () => {
    const limits = primed([{ id: "minimax-m3.1-flash", context_length: 1_000_000, max_output_tokens: 524_288 }]);
    expect(limits.peek("0g", "minimax-m3.1-flash", zeroG).outputTokens).toBe(32_768);
  });
  it("keeps every other provider at the shared ceiling", () => {
    const direct = target("openrouter", "https://openrouter.ai/api/v1");
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(direct, [{ id: "large", context_length: 1_000_000, max_output_tokens: 128_000 }]);
    expect(t.resolver.peek("openrouter", "large", direct).outputTokens).toBe(MAX_RESPONSE_TOKENS);
  });
  it("starts within a limit a provider stated, then tries the full limit again later", () => {
    const t = resolver(() => json({ data: [] }));
    t.resolver.prime(zeroG, [{ id: "glm-5.3", context_length: 1_179_648, max_output_tokens: 131_072 }]);
    t.resolver.learnOutput("0g", "glm-5.3", 20_000, zeroG);
    expect(t.resolver.peek("0g", "glm-5.3", zeroG).outputTokens).toBe(20_000);
    t.tick(5 * 60 * 60 * 1000);
    t.resolver.prime(zeroG, [{ id: "glm-5.3", context_length: 1_179_648, max_output_tokens: 131_072 }]);
    t.tick(2 * 60 * 60 * 1000);
    t.resolver.prime(zeroG, [{ id: "glm-5.3", context_length: 1_179_648, max_output_tokens: 131_072 }]);
    expect(t.resolver.peek("0g", "glm-5.3", zeroG).outputTokens).toBe(32_768);
  });
  it("marks image and video models and gives them a window a long chat fits", () => {
    const limits = primed([{ id: "clip", category: "video", unitPrice: "$0.2 per second" }, { id: "chat", context_length: 1_000_000, category: "chat" }]);
    expect(limits.media("0g", "clip", zeroG)).toEqual({ kind: "video", price: "$0.2 per second" });
    expect(limits.peek("0g", "clip", zeroG).contextTokens).toBe(1_000_000);
    expect(limits.media("0g", "chat", zeroG)).toBeUndefined();
  });
});

describe("refused reply budgets", () => {
  it("recognizes a refusal of the reply budget, not of the prompt", () => {
    expect(refusesOutputBudget("max_tokens must be at most 32768")).toBe(true);
    expect(refusesOutputBudget("max_completion_tokens is too large")).toBe(true);
    expect(refusesOutputBudget("Unsupported value for temperature")).toBe(false);
  });
  it("reads the limit the provider named", () => {
    expect(outputCeilingFromRefusal(JSON.stringify({ error: { message: "max_tokens must be in [1, 32768]" } }), 131_072)).toBe(32_768);
    expect(outputCeilingFromRefusal("max_tokens: 131,072 > 64,000, which is the maximum", 131_072)).toBe(64_000);
  });
  it("ignores numbers outside the message and falls back to the shared ceiling", () => {
    const refusal = JSON.stringify({ error: { message: "max_tokens is too large" }, x_0g_trace: { request_id: "90000" } });
    expect(outputCeilingFromRefusal(refusal, 131_072)).toBe(MAX_RESPONSE_TOKENS);
  });
  it("takes only a number stated as a limit, not a code, a model name or the window", () => {
    expect(outputCeilingFromRefusal('{"code":1214,"message":"max_tokens is too large"}', 131_072)).toBe(MAX_RESPONSE_TOKENS);
    expect(outputCeilingFromRefusal("max_tokens too large for gpt-4-1106-preview", 131_072)).toBe(MAX_RESPONSE_TOKENS);
    expect(outputCeilingFromRefusal("max_tokens must be at most 65536 (context window 200000)", 131_072)).toBe(65_536);
  });
});

describe("ModelLimitResolver", () => {
  it("asks Anthropic for its real window, sending the key only to Anthropic", async () => {
    const t = resolver(() => json({ id: "claude-x", max_input_tokens: 200_000, max_tokens: 64_000 }));
    const limits = await t.resolver.resolve(target("anthropic", "https://api.anthropic.com", "anthropic"), "claude-x");
    expect(limits).toMatchObject({ source: "provider", outputTokens: MAX_RESPONSE_TOKENS });
    // The prompt limit plus room for the reply, so the budget is never over what the provider accepts.
    expect(limits.contextTokens).toBe(200_000 + MAX_RESPONSE_TOKENS);
    const [url, init] = t.fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models/claude-x");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-secret-key");
    expect(init.redirect).toBe("manual");
  });

  it("reads Google's native model resource, not the OpenAI-compatible route", async () => {
    const t = resolver(() => json({ name: "models/gemini-x", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }));
    const limits = await t.resolver.resolve(target("google", "https://generativelanguage.googleapis.com/v1beta/openai"), "gemini-x");
    expect(t.fetcher.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x");
    expect((t.fetcher.mock.calls[0]![1].headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-secret-key");
    expect(limits.contextTokens).toBe(1_048_576 + MAX_RESPONSE_TOKENS);
  });

  it("finds a model in a gateway listing", async () => {
    const t = resolver(() => json({ data: [{ id: "x/y", context_length: 1_000_000 }, { id: "meta/llama", context_length: 131_072, top_provider: { max_completion_tokens: 8_192 } }] }));
    const limits = await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "meta/llama");
    expect(t.fetcher.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/models");
    expect(limits).toEqual({ contextTokens: 131_072, outputTokens: 8_192, source: "provider" });
  });

  it("reads Groq, Mistral and Fireworks from their own model resources", async () => {
    const groq = resolver(() => json({ id: "llama-3.3-70b-versatile", context_window: 131_072, max_completion_tokens: 32_768 }));
    expect(await groq.resolver.resolve(target("groq", "https://api.groq.com/openai/v1"), "llama-3.3-70b-versatile")).toMatchObject({ contextTokens: 131_072, source: "provider" });
    expect(groq.fetcher.mock.calls[0]![0]).toBe("https://api.groq.com/openai/v1/models/llama-3.3-70b-versatile");
    const mistral = resolver(() => json({ id: "mistral-large-latest", max_context_length: 128_000 }));
    expect((await mistral.resolver.resolve(target("mistral", "https://api.mistral.ai/v1"), "mistral-large-latest")).contextTokens).toBe(128_000);
    const fireworks = resolver(() => json({ name: "accounts/fireworks/models/m", contextLength: 65_536 }));
    const id = "accounts/fireworks/models/m";
    expect((await fireworks.resolver.resolve(target("fireworks", "https://api.fireworks.ai/inference/v1"), id)).contextTokens).toBe(65_536);
    expect(fireworks.fetcher.mock.calls[0]![0]).toBe("https://api.fireworks.ai/v1/accounts/fireworks/models/m");
    // A model ID that is not an account path is never turned into a URL.
    const refused = resolver(() => json({}));
    await refused.resolver.resolve(target("fireworks", "https://api.fireworks.ai/inference/v1"), "../../etc");
    expect(refused.fetcher).not.toHaveBeenCalled();
  });

  it("never asks OpenAI, and an operator override wins without any request", async () => {
    const openai = resolver(() => json({}));
    expect((await openai.resolver.resolve(target("openai", "https://api.openai.com/v1"), "gpt-6-luna")).source).toBe("published");
    expect(openai.fetcher).not.toHaveBeenCalled();
    const overridden = resolver(() => json({}), { "anthropic:claude-x": { contextTokens: 50_000, outputTokens: 4_000 } });
    expect(await overridden.resolver.resolve(target("anthropic", "https://api.anthropic.com", "anthropic"), "claude-x")).toEqual({ contextTokens: 50_000, outputTokens: 4_000, source: "override" });
    expect(overridden.fetcher).not.toHaveBeenCalled();
  });

  it("falls back to a family estimate, then the default, when the provider cannot be asked", async () => {
    const down = resolver(() => { throw new Error("offline"); });
    expect(await down.resolver.resolve(target("anthropic", "https://api.anthropic.com", "anthropic"), "claude-sonnet-9")).toMatchObject({ contextTokens: 200_000, source: "family" });
    expect(await down.resolver.resolve(target("custom", "https://example.com/v1"), "mystery")).toMatchObject({ contextTokens: 32_768, source: "default" });
    const forbidden = resolver(() => json({ error: "no" }, 403));
    expect((await forbidden.resolver.resolve(target("groq", "https://api.groq.com/openai/v1"), "llama-3.3-70b-versatile")).source).toBe("family");
  });

  it("does not trust a reply that echoes the API key", async () => {
    const t = resolver(() => json({ id: "m", context_length: 999_999, debug: "sk-secret-key" }));
    expect((await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "m")).source).toBe("default");
  });

  it.each([undefined, "1"])("bounds streamed metadata despite Content-Length=%s", async length => {
    const cancel = vi.fn();
    let pulls = 0;
    const t = resolver(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    }), { headers: length ? { "content-length": length } : {} }));
    expect((await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "m")).source).toBe("default");
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(10);
  });

  it("cancels rejected metadata without reading the body", async () => {
    const cancel = vi.fn();
    const t = resolver(() => new Response(new ReadableStream({ cancel }), { status: 403 }));
    await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "m");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("remembers answers, retries misses sooner than hits, and shares one in-flight request", async () => {
    const t = resolver(() => json({ data: [{ id: "m", context_length: 100_000 }] }));
    const openrouter = target("openrouter", "https://openrouter.ai/api/v1");
    await Promise.all([t.resolver.resolve(openrouter, "m"), t.resolver.resolve(openrouter, "m")]);
    await t.resolver.resolve(openrouter, "m");
    expect(t.fetcher).toHaveBeenCalledTimes(1);
    t.tick(7 * 60 * 60 * 1000);
    await t.resolver.resolve(openrouter, "m");
    expect(t.fetcher).toHaveBeenCalledTimes(2);
    const miss = resolver(() => json({}, 500));
    await miss.resolver.resolve(openrouter, "m");
    miss.tick(11 * 60 * 1000);
    await miss.resolver.resolve(openrouter, "m");
    expect(miss.fetcher).toHaveBeenCalledTimes(2);
  });

  it("peeks without a request and reflects what was already learned", async () => {
    const t = resolver(() => json({ data: [{ id: "m", context_length: 100_000 }] }));
    const openrouter = target("openrouter", "https://openrouter.ai/api/v1");
    expect(t.resolver.peek("openrouter", "m", openrouter).source).toBe("default");
    await t.resolver.resolve(openrouter, "m");
    expect(t.resolver.peek("openrouter", "m", openrouter)).toMatchObject({ contextTokens: 100_000, source: "provider" });
    expect(t.fetcher).toHaveBeenCalledTimes(1);
  });

  describe("learning from a refusal", () => {
    it("lowers the window to what the provider says and never raises it", async () => {
      const t = resolver(() => json({ data: [{ id: "m", context_length: 128_000 }] }));
      const openrouter = target("openrouter", "https://openrouter.ai/api/v1");
      await t.resolver.resolve(openrouter, "m");
      expect(t.resolver.learn("openrouter", "m", "This model's maximum context length is 65536 tokens.", openrouter)).toBe(65_536);
      expect(await t.resolver.resolve(openrouter, "m")).toMatchObject({ contextTokens: 65_536, source: "learned" });
      expect(t.resolver.learn("openrouter", "m", "maximum context length is 900000 tokens", openrouter)).toBeNull();
      expect(t.resolver.learn("openrouter", "m", "no numbers here", openrouter)).toBeNull();
      expect(t.resolver.learn("openrouter", "m", "maximum context length is 65536 tokens", openrouter)).toBeNull();
    });
    it("lets an operator override outrank anything learned", () => {
      const t = resolver(() => json({}), { "p:m": { contextTokens: 100_000, outputTokens: 4_000 } });
      expect(t.resolver.learn("p", "m", "maximum context length is 8192 tokens")).toBeNull();
      expect(t.resolver.peek("p", "m").source).toBe("override");
    });
  });
});

describe("ceilingFromRefusal", () => {
  it.each([
    ["This model's maximum context length is 128,000 tokens. However, your messages resulted in 150000 tokens.", 128_000],
    ["prompt is too long: 215482 tokens > 200000 maximum", 200_000],
    ["Input exceeds the context window of 8192 tokens", 8_192],
    ["Request too large: limit of 32768 tokens", 32_768],
  ])("reads %#", (message, expected) => expect(ceilingFromRefusal(message)).toBe(expected));
  it.each(["", "too many tokens", "maximum context length is 12 tokens", "maximum context length is 99999999 tokens"])(
    "ignores %#",
    (message) => expect(ceilingFromRefusal(message)).toBeNull(),
  );
});

describe("family estimates", () => {
  it("cover the major families under vendor prefixes and variants, but never OpenAI", () => {
    expect(familyLimits("anthropic", "claude-sonnet-4-6")?.[0]).toBe(200_000);
    expect(familyLimits("openrouter", "anthropic/claude-sonnet-4-6")?.[0]).toBe(200_000);
    expect(familyLimits("google", "gemini-2.0-flash")?.[0]).toBe(1_048_576);
    expect(familyLimits("together", "meta-llama/Llama-3.3-70B-Instruct-Turbo")?.[0]).toBe(131_072);
    expect(familyLimits("fireworks", "accounts/fireworks/models/llama-v3p1-70b-instruct")?.[0]).toBe(131_072);
    expect(familyLimits("mistral", "mistral-large-latest")?.[0]).toBe(128_000);
    expect(familyLimits("openrouter", "deepseek/deepseek-chat:free")?.[0]).toBe(64_000);
    expect(familyLimits("openai", "claude-x")).toBeUndefined();
    expect(familyLimits("venice", "venice-uncensored")).toBeUndefined();
  });
  it("never replace an exact published entry or an override", () => {
    expect(estimateModelLimits("openai", "gpt-6-luna").source).toBe("published");
    expect(estimateModelLimits("anthropic", "claude-x", { "anthropic:claude-x": { contextTokens: 9_000, outputTokens: 1_000 } }).source).toBe("override");
  });
});

it("isolates metadata by endpoint and credential and respects output-only reductions", async () => {
  const t = resolver((_url, init) => json({ data: [{ id: "claude-custom", max_output_tokens: (init.headers as Record<string,string>).authorization === "Bearer account-a" ? 1000 : 2000 }] }));
  const a = { ...target("openrouter", "https://openrouter.ai/api/v1"), apiKey: "account-a" };
  const b = { ...a, apiKey: "account-b" };
  expect(await t.resolver.resolve(a, "claude-custom")).toMatchObject({ outputTokens: 1000, source: "provider" });
  expect(await t.resolver.resolve(b, "claude-custom")).toMatchObject({ outputTokens: 2000, source: "provider" });
  expect(t.fetcher).toHaveBeenCalledTimes(2);
});
it("honors separate input limits even when a larger context is reported", async () => {
  const t = resolver(() => json({ data: [{ id: "m", context_length: 1000000, max_input_tokens: 10000, max_output_tokens: 1000 }] }));
  expect(await t.resolver.resolve(target("openrouter", "https://openrouter.ai/api/v1"), "m")).toMatchObject({ contextTokens: 11000, outputTokens: 1000 });
});
