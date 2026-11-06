/**
 * Per-model context and output budgets for Cloud Work.
 *
 * Every model used to get the same 16k context and 4k output, which wasted a
 * 1M-token model and could truncate a reasoning model. Budgets now come from
 * the model's published limits, an operator override, or a conservative default.
 */

/**
 * The worker refuses a lease whose output budget exceeds this, and direct
 * providers count the requested budget against rate limits, so it stays the
 * ceiling everywhere except the providers below.
 */
export const MAX_RESPONSE_TOKENS = 16_384;
/**
 * The API replaces the worker's output budget on every provider request, and
 * 0G admits a request on a flat minimum, so its models get their real limit.
 */
const RESPONSE_CEILINGS: Record<string, number> = { "0g": 524_288 };
export const responseCeiling = (providerId: string): number =>
  Object.hasOwn(RESPONSE_CEILINGS, providerId) ? RESPONSE_CEILINGS[providerId]! : MAX_RESPONSE_TOKENS;
/**
 * Vendor-published reply limits for 0G models whose listing leaves the field
 * empty. 0G's own figures always win, and a refusal lowers these at run time.
 */
const ZERO_G_UNLISTED_OUTPUT: Record<string, number> = {
  "glm-5-turbo": 131_072,
  "glm-5v-turbo": 128_000,
  "kimi-k2.5": 131_072,
  "kimi-k2.6": 131_072,
  "mimo-v2.5-pro": 131_072,
  "mimo-v2.6-flash": 131_072,
  "mimo-v2.6-pro": 131_072,
  "minimax-m2.5": 131_072,
  "minimax-m2.7": 131_072,
  "qwen3.5-flash": 65_536,
  "qwen3.5-plus": 65_536,
  "qwen3.6-flash": 65_536,
  "qwen3.7-flash": 65_536,
};
export const zeroGUnlistedOutput = (modelId: string): number | undefined =>
  Object.hasOwn(ZERO_G_UNLISTED_OUTPUT, modelId) ? ZERO_G_UNLISTED_OUTPUT[modelId] : undefined;
/** Used for any model that is neither published below nor overridden. */
export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const DEFAULT_OUTPUT_TOKENS = 4_096;
const MAX_CONTEXT_TOKENS = 4_000_000;
const MIN_CONTEXT_TOKENS = 4_096;

export interface ModelLimits {
  contextTokens: number;
  outputTokens: number;
  /**
   * Where the numbers came from, most to least trustworthy: an operator
   * override, the provider's own error (learned), the provider's model
   * metadata (provider), a reviewed published table (published), a model-family
   * estimate (family), or the conservative default.
   */
  source:
    | "override"
    | "learned"
    | "provider"
    | "published"
    | "family"
    | "default";
}
export type ModelLimitOverrides = Record<
  string,
  { contextTokens: number; outputTokens: number }
>;

/** Exact provider and model IDs only: a similarly named custom model must not inherit these. */
const PUBLISHED: Record<string, Record<string, [number, number]>> = {
  openai: {
    "gpt-6-astra": [1_050_000, 128_000],
    "gpt-6.1-sol": [1_050_000, 128_000],
    "gpt-6-luna": [1_050_000, 128_000],
    "gpt-4.1": [1_047_576, 32_768],
    "gpt-4.1-mini": [1_047_576, 32_768],
    "gpt-4.1-nano": [1_047_576, 32_768],
    "gpt-5": [400_000, 128_000],
    "gpt-5-mini": [400_000, 128_000],
    "gpt-5-nano": [400_000, 128_000],
    "gpt-4o": [128_000, 16_384],
    "gpt-4o-mini": [128_000, 16_384],
  },
};

export function publishedModelLimits(providerId: string, modelId: string): [number, number] | undefined {
  const models = Object.hasOwn(PUBLISHED, providerId) ? PUBLISHED[providerId] : undefined;
  return models && Object.hasOwn(models, modelId) ? models[modelId] : undefined;
}

export function resolveModelLimits(
  providerId: string,
  modelId: string,
  overrides: ModelLimitOverrides = {},
): ModelLimits {
  const overrideKey = `${providerId}:${modelId}`;
  const override = Object.hasOwn(overrides, overrideKey)
    ? overrides[overrideKey]
    : undefined;
  // Own-property lookups only: a model ID of "__proto__" must not resolve to a prototype.
  const models = Object.hasOwn(PUBLISHED, providerId)
    ? PUBLISHED[providerId]
    : undefined;
  const published =
    models && Object.hasOwn(models, modelId) ? models[modelId] : undefined;
  const [contextTokens, outputTokens, source] = override
    ? [override.contextTokens, override.outputTokens, "override" as const]
    : published
      ? [published[0], published[1], "published" as const]
      : [DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS, "default" as const];
  return {
    contextTokens,
    // Never above the worker's ceiling, and always leaving room for input.
    outputTokens: Math.max(
      1,
      Math.min(outputTokens, MAX_RESPONSE_TOKENS, Math.floor(contextTokens / 2)),
    ),
    source,
  };
}

/**
 * Conservative family estimates for providers whose model metadata cannot be
 * read (offline, a restricted key, an unlisted model). They are deliberately at
 * or below the smallest current member of each family: too low only means more
 * compaction, too high would mean a refused request. A refusal teaches the
 * real ceiling (see model-limit-discovery.ts). OpenAI is excluded: its models
 * are matched by exact ID only.
 */
const FAMILIES: [RegExp, number, number][] = [
  [/^claude-/, 200_000, 32_000],
  [/^gemini-/, 1_048_576, 65_536],
  // Sources disagree on Codestral (32K to 256K by release), so take the smallest.
  [/^codestral/, 32_768, 8_192],
  [/^mistral-(?:large|medium)/, 128_000, 16_384],
  [/^(?:mistral-small|ministral|magistral|pixtral)/, 32_768, 8_192],
  [/llama-?(?:v)?3(?:\.|p)[1-3]/, 131_072, 8_192],
  [/^deepseek-/, 64_000, 8_192],
];

/** `vendor/model:variant` and `accounts/x/models/model` all name the same model family. */
function bareModelName(modelId: string): string {
  return (modelId.split("/").at(-1) ?? modelId).split(":")[0]!.toLowerCase();
}

export function familyLimits(
  providerId: string,
  modelId: string,
): [number, number] | undefined {
  if (providerId === "openai") return undefined;
  const name = bareModelName(modelId);
  const family = FAMILIES.find(([pattern]) => pattern.test(name));
  return family ? [family[1], family[2]] : undefined;
}

/**
 * Limits without asking the provider: an override, the published table, a
 * family estimate, then the default. Used wherever no network call is wanted
 * (for example listing models); runs use the resolver in model-limit-discovery.ts.
 */
export function estimateModelLimits(
  providerId: string,
  modelId: string,
  overrides: ModelLimitOverrides = {},
): ModelLimits {
  const known = resolveModelLimits(providerId, modelId, overrides);
  if (known.source !== "default") return known;
  const family = familyLimits(providerId, modelId);
  return family ? limitsFrom(family[0], family[1], "family") : known;
}

/** Applies the worker ceiling and the room-for-input rule to raw numbers. */
export function limitsFrom(
  contextTokens: number,
  outputTokens: number,
  source: ModelLimits["source"],
  ceiling = MAX_RESPONSE_TOKENS,
): ModelLimits {
  return {
    contextTokens,
    outputTokens: Math.max(
      1,
      Math.min(outputTokens, ceiling, Math.floor(contextTokens / 2)),
    ),
    source,
  };
}

/**
 * Input the planner may send: the context window less the response and the
 * same 10% safety margin the worker applies, so the two never disagree.
 */
export function inputTokenBudget(limits: ModelLimits): number {
  return (
    limits.contextTokens -
    limits.outputTokens -
    Math.floor(limits.contextTokens / 10)
  );
}

/**
 * OpenAI's current models reject `max_tokens` (`unsupported_parameter`) and
 * require `max_completion_tokens`. OpenAI-compatible providers and Anthropic
 * still expect `max_tokens`.
 */
export function outputBudgetParams(
  protocol: "openai" | "anthropic",
  providerId: string,
  tokens: number,
): Record<string, number> {
  return protocol === "openai" && providerId === "openai"
    ? { max_completion_tokens: tokens }
    : { max_tokens: tokens };
}

/**
 * Parses `WORK_CLOUD_MODEL_LIMITS`, a JSON object keyed `provider:model`, for
 * models whose limits are not published above. Throws a clear error rather
 * than silently running with limits the operator did not intend.
 */
export function parseModelLimitOverrides(
  raw: string | undefined,
): ModelLimitOverrides {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WORK_CLOUD_MODEL_LIMITS must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("WORK_CLOUD_MODEL_LIMITS must be a JSON object.");
  const result: ModelLimitOverrides = {};
  for (const [key, value] of Object.entries(parsed)) {
    const separator = key.indexOf(":");
    if (separator < 1 || separator === key.length - 1)
      throw new Error(
        `WORK_CLOUD_MODEL_LIMITS key "${key}" must look like provider:model.`,
      );
    const entry = value as { contextTokens?: unknown; outputTokens?: unknown };
    const { contextTokens, outputTokens } = entry ?? {};
    if (
      !Number.isInteger(contextTokens) ||
      !Number.isInteger(outputTokens) ||
      (contextTokens as number) < MIN_CONTEXT_TOKENS ||
      (contextTokens as number) > MAX_CONTEXT_TOKENS ||
      (outputTokens as number) < 1 ||
      (outputTokens as number) >= (contextTokens as number)
    )
      throw new Error(
        `WORK_CLOUD_MODEL_LIMITS "${key}" needs integer contextTokens (${MIN_CONTEXT_TOKENS}–${MAX_CONTEXT_TOKENS}) and outputTokens (1 up to below contextTokens).`,
      );
    result[key] = {
      contextTokens: contextTokens as number,
      outputTokens: outputTokens as number,
    };
  }
  return result;
}
