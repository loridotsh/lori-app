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
  imagesOff.clear();
}

/**
 * Tool results can carry rendered pages as images, which a text-only model
 * refuses outright. The listing says so ahead of time where a provider publishes
 * it; otherwise the refusal teaches the same thing, the way reasoning does above.
 */
const imagesOff = new Map<string, number>();
const IMAGES_OFF_TTL_MS = 6 * 60 * 60 * 1000;
const IMAGE_PARTS = new Set(["image_url", "image", "input_image"]);
const NOT_SHOWN =
  "[This image was not shown because this model cannot view images. Check the document with read_document or validate_document instead, and say so if the visual layout could not be reviewed.]";

/** A refusal of images as such, not of one file's format or size. */
export function rejectsImages(body: string): boolean {
  return /model_not_capable|(?:model|endpoint)[^."]{0,60}(?:does not|doesn't|do not) (?:support|accept) (?:images?\b(?! format)|vision)|image input is not supported/i.test(body);
}

/** Scoped to one provider connection, so one tenant's refusal never reaches another. */
export function imagesDisabledFor(gatewayId: string, modelId: string, now = Date.now()): boolean {
  const at = imagesOff.get(key(gatewayId, modelId));
  return at !== undefined && now - at < IMAGES_OFF_TTL_MS;
}

export function rememberImagesDisabled(gatewayId: string, modelId: string, now = Date.now()): void {
  if (imagesOff.size >= MAX_REMEMBERED) {
    const oldest = imagesOff.keys().next().value;
    if (oldest !== undefined) imagesOff.delete(oldest);
  }
  imagesOff.set(key(gatewayId, modelId), now);
}

const isImage = (part: unknown) =>
  !!part && typeof part === "object" && IMAGE_PARTS.has(String((part as { type?: unknown }).type));
const carriesImage = (message: unknown) => {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) && content.some(isImage);
};

export function hasImages(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && body.messages.some(carriesImage);
}

/** Replaces each image with a note, so the model knows what it could not see. */
export function withoutImages(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasImages(body)) return body;
  return {
    ...body,
    messages: (body.messages as { content: unknown[] }[]).map((message) =>
      carriesImage(message)
        ? { ...message, content: message.content.map((part) => (isImage(part) ? { type: "text", text: NOT_SHOWN } : part)) }
        : message,
    ),
  };
}
