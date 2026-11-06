export function apiFailureDestination(...statuses: number[]): string {
  if (statuses.includes(401)) return "/sign-in";
  if (statuses.some((status) => status >= 500 || status <= 0)) {
    return "/service-unavailable";
  }
  return "/unauthorized";
}
