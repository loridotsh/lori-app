import { NextResponse, type NextRequest } from "next/server";

const apiUrl = process.env.LORI_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

/**
 * Next requires an absolute redirect target. Keep the host the member used and
 * take only the scheme (http or https, nothing else) from the edge, so the
 * redirect can never point anywhere the request did not already come from.
 */
function workOffUrl(request: NextRequest) {
  const url = request.nextUrl.clone();
  const scheme = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (scheme === "https" || scheme === "http") url.protocol = scheme;
  url.pathname = "/work";
  url.search = "?cloud=off";
  return url;
}

/**
 * Cloud Work follows Work access. When Work is definitively off, answer with a
 * real redirect before anything renders. This is a convenience layer only: the
 * page re-checks, and the API refuses every Cloud Work operation regardless.
 * Any doubt (no session, API unreachable, unreadable answer) falls through so
 * the page can sign the member in or show its own recovery state.
 */
export async function proxy(request: NextRequest) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return NextResponse.next();
  try {
    const response = await fetch(`${apiUrl}/v1/work/cloud/capabilities`, {
      cache: "no-store",
      headers: { cookie },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { enabled?: unknown };
      if (body.enabled === false) {
        const redirect = NextResponse.redirect(workOffUrl(request), 307);
        redirect.headers.set("cache-control", "no-store");
        return redirect;
      }
    }
  } catch {
    // Fail open to the page, which handles its own failures.
  }
  return NextResponse.next();
}

export const config = { matcher: ["/work/cloud"] };
