export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Values under keys like these are never shown, whatever a service returned. */
export const SENSITIVE =
  /token|secret|password|passwd|api[_-]?key|authorization|credential|cookie/i;

/**
 * Bookkeeping the member has no use for: identifiers the model needs to page a
 * result, hashes, and flags that only describe how the result was packaged.
 */
export const HIDDEN_KEYS = new Set([
  "truncated",
  "invocationId",
  "kind",
  "effectsApplied",
  "schemaHash",
  "connectionId",
  "connectionRevision",
  "expected_hash",
  "expected_version",
  "untrusted",
]);

const JSON_LIMIT = 16_000;

/** JSON with sensitive-looking values removed at any depth, bounded in size. */
export function safeJson(value: unknown): string {
  const text = JSON.stringify(
    value,
    (key, inner) => (key && SENSITIVE.test(key) ? "[redacted]" : inner),
    2,
  );
  return (text ?? "").slice(0, JSON_LIMIT);
}

/** "nextOffset" -> "next offset", "size_bytes" -> "size bytes", then sentence case. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** A JSON object or array carried inside a string, as services often return. */
export function parseEmbeddedJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 200_000) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) && Math.abs(value) < 1e15
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
