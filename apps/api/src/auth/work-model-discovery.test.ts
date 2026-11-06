import { describe, expect, it, vi } from "vitest";
import { cachedWorkModels, discoverWorkModels, listingKeyAccepted, modelMetadata, supportsModelSync, syncableModelIds } from "./work-model-discovery.js";
import { withSyncedModels } from "./work-service.js";
import { syncedModelIds } from "./provider-gateway-service.js";
const target = { providerId: "anthropic", protocol: "anthropic" as const, upstreamBaseUrl: "https://api.anthropic.com", apiKey: "test-secret" };
describe("automatic Work models", () => {
  const policy = { enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [], providerModels: [], forceAskMe: false, memoryAllowed: true };
  const synced = [{ providerId: "0g", modelIds: ["glm-5.3", "glm-5.2"] }];

  it("enables chat models that can call tools, then image and video models", () => {
    expect(syncableModelIds([
      { id: "chat", name: "c", category: "chat", runsInWork: true },
      { id: "no-tools", name: "n", category: "chat", runsInWork: false },
      { id: "image", name: "i", category: "image", runsInWork: true },
      { id: "embed", name: "e", category: "other", runsInWork: false },
      { id: "untyped", name: "u" },
      { id: "x".repeat(129), name: "long", category: "chat", runsInWork: true },
    ])).toEqual(["chat", "image"]);
  });
  it("is limited to providers whose listing identifies usable models", () => {
    expect(supportsModelSync("0g")).toBe(true);
    expect(supportsModelSync("openrouter")).toBe(false);
  });
  it("turns the provider on and adds its models without a stored assignment", () => {
    const next = withSyncedModels(policy, synced);
    expect(next.managedCatalog).toEqual([{ id: "0g", type: "provider", enabled: true }]);
    expect(next.providerModels).toEqual([{ providerId: "0g", modelIds: ["glm-5.2", "glm-5.3"] }]);
    expect(policy.providerModels).toEqual([]);
  });
  it("keeps models an administrator chose alongside synced ones", () => {
    const next = withSyncedModels({ ...policy, providerModels: [{ providerId: "0g", modelIds: ["custom"] }] }, synced);
    expect(next.providerModels[0]!.modelIds).toEqual(["custom", "glm-5.2", "glm-5.3"]);
  });
  it("never overrides an organization that blocked the provider", () => {
    const blocked = { ...policy, managedCatalog: [{ id: "0g", type: "provider" as const, enabled: false }] };
    expect(withSyncedModels(blocked, synced)).toMatchObject({ managedCatalog: blocked.managedCatalog, providerModels: [] });
  });
  it("grants nothing until a list exists", () => {
    expect(withSyncedModels(policy, [{ providerId: "0g", modelIds: [] }]).managedCatalog).toEqual([]);
  });
  it("is not bound by the hand-assignment cap and tolerates a bad stored value", () => {
    const many = Array.from({ length: 96 }, (_, index) => `m${index}`);
    expect(syncedModelIds(many)).toHaveLength(96);
    expect(syncedModelIds("corrupt")).toEqual([]);
    expect(syncedModelIds(["ok", 3])).toEqual(["ok"]);
  });
});

describe("0G model listing", () => {
  const zeroG = { providerId: "0g", protocol: "openai" as const, upstreamBaseUrl: "https://router-api.0g.ai/v1", apiKey: "sk-test-secret" };
  const chat = { id: "glm-5.2", name: "GLM-5.2", type: "chatbot", context_length: 1179648, max_completion_tokens: 131072, supported_parameters: ["tools", "stream"], pricing: { prompt: "8637872615374" }, pricing_usd: { prompt: "0.000002", completion: "0.000004" } };
  const video = (unit: string, prices: string[]) => ({ id: `video-${unit}`, name: "Video", type: "video-generation", pricing_usd: { variants: prices.map((unit_price) => ({ unit, unit_price })) } });

  it("lists chat, image and video models from the live response shape", async () => {
    const fetcher = vi.fn(async (_url: unknown) => json({ object: "list", data: [chat, { id: "bytedance/seedream-5.0-flash", name: "Seedream", type: "text-to-image", pricing_usd: { image: "0.027" } }, video("video_token", ["0.0000107", "0.0000064"]), { id: "laya", name: "Laya", type: "decisions" }] }));
    const models = await discoverWorkModels(zeroG, fetcher as unknown as typeof fetch);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://router-api.0g.ai/v1/models");
    expect(models.map((m) => [m.id, m.category, m.runsInWork])).toEqual([
      ["bytedance/seedream-5.0-flash", "image", true],
      ["glm-5.2", "chat", true],
      ["laya", "other", false],
      ["video-video_token", "video", true],
    ]);
  });
  it("reads USD prices, never the neuron-denominated field", () => {
    const model = modelMetadata(chat, "0g");
    expect(model).toMatchObject({ context_length: 1179648, max_output_tokens: 131072 });
    expect(model?.workPricing?.input).toBeCloseTo(2);
    expect(model?.workPricing?.output).toBeCloseTo(4);
  });
  it("marks chat models without tool calling as unable to run in Work", () => {
    expect(modelMetadata({ ...chat, supported_parameters: ["stream"] }, "0g")).toMatchObject({ category: "chat", runsInWork: false });
  });
  it("states media prices in their own billing unit", () => {
    expect(modelMetadata({ id: "i", type: "text-to-image", pricing_usd: { image: "0.027" } }, "0g")?.unitPrice).toBe("$0.027 per image");
    expect(modelMetadata({ id: "i", type: "text-to-image", pricing_usd: { image: "0.0252", variants: [{ unit: "image", unit_price: "0.0252" }, { unit: "image", unit_price: "0.0336" }] } }, "0g")?.unitPrice).toBe("From $0.0252 per image");
    expect(modelMetadata(video("video_token", ["0.0000107", "0.0000064"]), "0g")?.unitPrice).toBe("From $6.4 per 1M video tokens");
    expect(modelMetadata(video("video_second", ["0.195"]), "0g")?.unitPrice).toBe("$0.195 per second");
    expect(modelMetadata(video("unknown_unit", ["1"]), "0g")?.unitPrice).toBeUndefined();
  });
  it("leaves other providers' listings untyped", () => {
    expect(modelMetadata(chat, "openrouter")).not.toHaveProperty("category");
  });
  it("refuses a key only on an explicit credential refusal", async () => {
    const reply = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await listingKeyAccepted(zeroG, reply(401))).toBe(false);
    expect(await listingKeyAccepted(zeroG, reply(403))).toBe(false);
    expect(await listingKeyAccepted(zeroG, reply(400))).toBe(true);
    expect(await listingKeyAccepted(zeroG, reply(402))).toBe(true);
  });
  it("never spends a request verifying providers whose listing already needs the key", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await listingKeyAccepted(target, fetcher)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
const json = (value: unknown) => new Response(JSON.stringify(value));
describe("Work model discovery", () => {
  it("paginates official models and retains limits without granting assignments", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [{ id: "a", max_input_tokens: 200000, max_tokens: 64000 }], has_more: true, last_id: "a" })).mockResolvedValueOnce(json({ data: [{ id: "b" }], has_more: false }));
    expect(await discoverWorkModels(target, fetcher)).toEqual([
      { id: "a", name: "a", max_input_tokens: 200000, max_output_tokens: 64000 }, { id: "b", name: "b" },
    ]);
    expect(String(fetcher.mock.calls[1]![0])).toContain("after_id=a");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual", headers: { "x-api-key": "test-secret" } });
  });
  it("does not retain credentials, including escaped values, or follow redirects", async () => {
    await expect(discoverWorkModels(target, vi.fn(async () => new Response('{"data":[{"id":"a","name":"test-\\u0073ecret"}]}')))).rejects.toThrow("Invalid model list");
    await expect(discoverWorkModels(target, vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } })))).rejects.toThrow();
  });
  it("bounds response bytes and repeated pagination", async () => {
    await expect(discoverWorkModels(target, vi.fn(async () => json({ data: [], has_more: true, last_id: "same" })))).rejects.toThrow("Invalid model cursor");
    await expect(discoverWorkModels(target, vi.fn(async () => new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } })))).rejects.toThrow();
  });
  it("preserves exact published capacities and distinguishes zero from unknown pricing", () => {
    expect(modelMetadata({ id: "gpt-4.1" }, "openai")).toMatchObject({ context_length: 1047576, max_output_tokens: 32768 });
    expect(modelMetadata({ id: "custom-gpt-4.1" }, "openai")).toEqual({ id: "custom-gpt-4.1", name: "custom-gpt-4.1" });
    expect(modelMetadata({ id: "m", pricing: { prompt: "0", completion: "0.000003", input_cache_read: "-1" } }, "openrouter")?.pricing).toEqual({ prompt: 0, completion: 0.000003 });
    expect(modelMetadata({ id: "m", pricing: { prompt: "" } }, "openrouter")?.pricing).toBeUndefined();
  });
  it("uses native Gemini metadata and excludes non-generation models", async () => {
    const fetcher = vi.fn(async (_url: unknown) => json({ models: [{ name: "models/gem", inputTokenLimit: 1000, outputTokenLimit: 500, supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }));
    const models = await discoverWorkModels({ ...target, providerId: "google", protocol: "openai", upstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, fetcher);
    expect(models).toEqual([{ id: "gem", name: "models/gem", max_input_tokens: 1000, max_output_tokens: 500 }]);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/v1beta/models");
  });
});

it("remembers a failed listing briefly instead of retrying the upstream for every round", async () => {
  const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
  const failing = { ...target, apiKey: "cache-failing-account" };
  expect(await cachedWorkModels(failing, fetcher)).toEqual([]);
  expect(await cachedWorkModels(failing, fetcher)).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("shares metadata for the same account across devices without sharing across credentials", async () => {
 const fetcher=vi.fn(async()=>json({data:[{id:"cached"}]}));vi.stubGlobal("fetch",fetcher);
 try {
   await cachedWorkModels({...target,apiKey:"cache-account-a",deviceId:"one"} as typeof target);
   await cachedWorkModels({...target,apiKey:"cache-account-a",deviceId:"two"} as typeof target);
   expect(fetcher).toHaveBeenCalledTimes(1);
   await cachedWorkModels({...target,apiKey:"cache-account-b"});
   expect(fetcher).toHaveBeenCalledTimes(2);
 } finally {vi.unstubAllGlobals();}
});
