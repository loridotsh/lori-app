import { describe, expect, it } from "vitest";
import { mentionsUnknownModel, providerFailureFor } from "./service.js";

describe("mentionsUnknownModel", () => {
  it.each([
    '{"error":{"message":"The model `gpt-6-luna` does not exist","type":"invalid_request_error","param":"model","code":"model_not_found"}}',
    '{"error":{"message":"Invalid model ID","param":"model"}}',
    '{"error":{"message":"Unknown model: gpt-x"}}',
    '{"error":{"message":"Model gpt-x is not supported for this endpoint"}}',
    '{"error":{"message":"The model gpt-4-0314 has been decommissioned"}}',
    "no such model",
  ])("recognizes an unusable model: %s", (body) => {
    expect(mentionsUnknownModel(body)).toBe(true);
  });
  it.each([
    '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."}}',
    '{"error":{"message":"context_length_exceeded for model gpt-4"}}',
    '{"error":{"message":"max_tokens is too large: 99999. This model supports at most 4096 completion tokens"}}',
    '{"error":{"message":"Unsupported value for parameter temperature"}}',
    '{"model":"gpt-4o","error":"bad request"}',
    "",
  ])("does not mistake an unrelated rejection for a missing model: %s", (body) => {
    expect(mentionsUnknownModel(body)).toBe(false);
  });
});

describe("providerFailureFor", () => {
  it.each([
    [401, false, "provider_auth_failed"],
    [403, false, "provider_auth_failed"],
    [404, false, "provider_model_unavailable"],
    [400, true, "provider_model_unavailable"],
    [422, true, "provider_model_unavailable"],
    [400, false, "provider_request_rejected"],
    [429, false, "provider_rate_limited"],
    [408, false, "provider_rate_limited"],
    [500, false, "provider_unavailable"],
    [503, false, "provider_unavailable"],
    [0, false, "provider_unavailable"],
  ] as const)("maps status %i (mentions model: %s) to %s", (status, model, cause) => {
    expect(providerFailureFor(status, model)).toBe(cause);
  });
});
