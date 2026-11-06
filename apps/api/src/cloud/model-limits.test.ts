import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  MAX_RESPONSE_TOKENS,
  inputTokenBudget,
  outputBudgetParams,
  parseModelLimitOverrides,
  resolveModelLimits,
} from "./model-limits.js";

describe("resolveModelLimits", () => {
  it("uses the published 1M-token window for gpt-6-luna, capped to what the worker accepts for output", () => {
    const limits = resolveModelLimits("openai", "gpt-6-luna");
    expect(limits).toEqual({
      contextTokens: 1_050_000,
      outputTokens: MAX_RESPONSE_TOKENS,
      source: "published",
    });
    // Large enough that history is no longer cut off at the old ~10k budget.
    expect(inputTokenBudget(limits)).toBe(1_050_000 - 16_384 - 105_000);
  });
  it("falls back to a conservative default for unknown, similarly named and other-provider models", () => {
    for (const [provider, model] of [
      ["openai", "gpt-6-luna-custom"],
      ["openai", "ft:gpt-4.1:org:test"],
      ["openrouter", "gpt-6-luna"],
      ["custom", "anything"],
      ["openai", "__proto__"],
      ["__proto__", "gpt-6-luna"],
    ] as const)
      expect(resolveModelLimits(provider, model)).toEqual({
        contextTokens: DEFAULT_CONTEXT_TOKENS,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
        source: "default",
      });
  });
  it("keeps the old budget for the default so unlisted models behave as before", () => {
    expect(inputTokenBudget(resolveModelLimits("custom", "m"))).toBe(
      32_768 - 4_096 - 3_276,
    );
  });
  it("lets an operator override win and still respects the worker ceiling", () => {
    const overrides = {
      "openai:gpt-6-luna": { contextTokens: 500_000, outputTokens: 64_000 },
      "openrouter:vendor/model:free": { contextTokens: 200_000, outputTokens: 8_192 },
    };
    expect(resolveModelLimits("openai", "gpt-6-luna", overrides)).toEqual({
      contextTokens: 500_000,
      outputTokens: MAX_RESPONSE_TOKENS,
      source: "override",
    });
    expect(resolveModelLimits("openrouter", "vendor/model:free", overrides)).toMatchObject({
      contextTokens: 200_000,
      outputTokens: 8_192,
    });
  });
  it("always leaves room for input, even for small windows", () => {
    const limits = resolveModelLimits("p", "m", {
      "p:m": { contextTokens: 4_096, outputTokens: 4_000 },
    });
    expect(limits.outputTokens).toBeLessThanOrEqual(2_048);
    expect(inputTokenBudget(limits)).toBeGreaterThan(0);
  });
});

describe("outputBudgetParams", () => {
  it("sends max_completion_tokens to OpenAI itself and max_tokens everywhere else", () => {
    expect(outputBudgetParams("openai", "openai", 100)).toEqual({ max_completion_tokens: 100 });
    for (const provider of ["openrouter", "groq", "together", "ollama"])
      expect(outputBudgetParams("openai", provider, 100)).toEqual({ max_tokens: 100 });
    expect(outputBudgetParams("anthropic", "anthropic", 100)).toEqual({ max_tokens: 100 });
    expect(outputBudgetParams("anthropic", "openai", 100)).toEqual({ max_tokens: 100 });
  });
});

describe("parseModelLimitOverrides", () => {
  it("accepts an empty value and a valid map", () => {
    expect(parseModelLimitOverrides(undefined)).toEqual({});
    expect(parseModelLimitOverrides("  ")).toEqual({});
    expect(
      parseModelLimitOverrides(
        '{"ollama:local:latest":{"contextTokens":131072,"outputTokens":4096}}',
      ),
    ).toEqual({ "ollama:local:latest": { contextTokens: 131072, outputTokens: 4096 } });
  });
  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a missing provider", '{":m":{"contextTokens":8192,"outputTokens":10}}'],
    ["a missing model", '{"p:":{"contextTokens":8192,"outputTokens":10}}'],
    ["no separator", '{"pm":{"contextTokens":8192,"outputTokens":10}}'],
    ["a tiny window", '{"p:m":{"contextTokens":100,"outputTokens":10}}'],
    ["an absurd window", '{"p:m":{"contextTokens":99999999,"outputTokens":10}}'],
    ["output not below context", '{"p:m":{"contextTokens":8192,"outputTokens":8192}}'],
    ["a fractional value", '{"p:m":{"contextTokens":8192.5,"outputTokens":10}}'],
    ["a string value", '{"p:m":{"contextTokens":"8192","outputTokens":10}}'],
    ["a null entry", '{"p:m":null}'],
  ])("rejects %s with an explanatory error", (_name, raw) => {
    expect(() => parseModelLimitOverrides(raw)).toThrow(/WORK_CLOUD_MODEL_LIMITS/);
  });
});
