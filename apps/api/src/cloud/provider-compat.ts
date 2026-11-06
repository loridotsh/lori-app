/**
 * Provider quirks Cloud Work adapts to instead of failing the member's turn.
 *
 * Current OpenAI reasoning models refuse function tools combined with a reasoning
 * effort on Chat Completions ("use /v1/responses or set reasoning_effort to
 * 'none'"). Cloud Work speaks Chat Completions, so on that specific refusal the
 * request is retried once with reasoning off and the model is remembered for
 * this process so later turns skip the failed attempt.
 */

const MAX_REMEMBERED = 500;
const reasoningOffForTools = new Set<string>();

const key = (providerId: string, modelId: string) => `${providerId}:${modelId}`;

/** True for the provider's refusal of function tools together with reasoning. */
export function rejectsReasoningWithTools(body: string): boolean {
  return (
    /reasoning_effort/i.test(body) &&
    /function tools|tools? (?:are|is) not supported|set reasoning_effort to ['"]?none/i.test(
      body,
    )
  );
}

export function reasoningDisabledFor(
  providerId: string,
  modelId: string,
): boolean {
  return reasoningOffForTools.has(key(providerId, modelId));
}

export function rememberReasoningDisabled(
  providerId: string,
  modelId: string,
): void {
  if (reasoningOffForTools.size >= MAX_REMEMBERED) {
    // Bounded: forget the oldest entry rather than grow with every model name seen.
    const oldest = reasoningOffForTools.values().next().value;
    if (oldest !== undefined) reasoningOffForTools.delete(oldest);
  }
  reasoningOffForTools.add(key(providerId, modelId));
}

export function withReasoningDisabled(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { ...body, reasoning_effort: "none" };
}

/** Test seam. */
export function forgetReasoningCompat(): void {
  reasoningOffForTools.clear();
}
