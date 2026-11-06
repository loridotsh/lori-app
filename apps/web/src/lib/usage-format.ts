export function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function formatEstimatedCost(microusd: number): string {
  const usd = microusd / 1_000_000;
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: usd > 0 && usd < 0.01 ? 6 : usd < 1 ? 2 : 0,
    minimumFractionDigits: usd > 0 && usd < 1 ? 2 : 0,
    style: "currency",
  }).format(usd);
}

export function formatUsageDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function timeZoneLabel(date: Date, locale: string | undefined, timeZone: string): string {
  const shortLabel = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;

  if (shortLabel && !/^GMT[+-]/u.test(shortLabel)) return shortLabel;

  const longLabel = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "long",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const abbreviation = longLabel
    ?.split(/\s+/u)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

  return abbreviation && /^[A-Z]{2,5}$/u.test(abbreviation)
    ? abbreviation
    : shortLabel ?? timeZone;
}

export function formatLocalDateTime(
  value?: string,
  options: { locale?: string; timeZone?: string } = {},
): string {
  if (!value) return "Not received yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  const timeZone = options.timeZone
    ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatted = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);

  return `${formatted} ${timeZoneLabel(date, options.locale, timeZone)}`;
}

export function formatCoveredCost(totals: { estimatedCostMicrousd: number; totalTokens: number; costCoveragePercent: number }): string {
  if (totals.totalTokens > 0 && totals.costCoveragePercent === 0) return "Unavailable";
  const cost = formatEstimatedCost(totals.estimatedCostMicrousd);
  return totals.totalTokens > 0 && totals.costCoveragePercent < 100 ? `${cost} (partial)` : cost;
}
