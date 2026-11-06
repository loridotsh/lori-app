/** Return a local redirect path, including after URL dot-segment normalization. */
export function safeCallback(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") ||
      value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  try {
    const resolved = new URL(value, "https://lori.invalid");
    // /safe/..//attacker.example has our origin during parsing, but its
    // pathname becomes a network-path reference when used as a redirect.
    if (resolved.origin !== "https://lori.invalid" || resolved.pathname.startsWith("//")) return "/";
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return "/";
  }
}
