/** Read at request time: standalone images use the operator's runtime upstream. */
export function internalApiOrigin(): URL {
  const url = new URL(
    process.env.LORI_API_INTERNAL_URL ?? "http://127.0.0.1:4000",
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) throw new Error("invalid_api_origin");
  return url;
}

const requestHeaders = [
  "accept", "authorization", "content-type", "cookie", "origin", "referer",
  "if-match", "if-none-match", "last-event-id", "range", "x-lori-protocol-version",
  "anthropic-version", "anthropic-beta", "x-lori-project-id", "x-lori-project-client-version",
];
const hopHeaders = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
];

export async function proxyApiRequest(request: Request): Promise<Response> {
  let upstream: URL;
  try {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/")) throw new Error("invalid_path");
    upstream = internalApiOrigin();
    // Assign pathname rather than resolving untrusted paths as a URL: a leading
    // double slash must never choose a different host and receive credentials.
    upstream.pathname = incoming.pathname.startsWith("/api/auth/")
      ? incoming.pathname : incoming.pathname.slice(4);
    upstream.search = incoming.search;
    // Worker-only routes belong to the private network, never to browsers.
    // Fastify decodes percent-encoded static segments before matching routes.
    if (decodeURIComponent(upstream.pathname).startsWith("/v1/internal/"))
      return Response.json(
        { error: "not_found", message: "Not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
  } catch {
    return unavailable();
  }
  const headers = new Headers({ "accept-encoding": "identity" });
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "manual",
      // A large file can take longer to download than any other request should.
      signal: /\/files\/[^/]+\/content$/.test(upstream.pathname)
        ? request.signal
        : AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
    };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await fetch(upstream, init);
    const outgoing = new Headers(response.headers);
    for (const name of hopHeaders) outgoing.delete(name);
    // Fetch decompresses upstream responses. Never label those bytes compressed.
    outgoing.delete("content-encoding");
    outgoing.delete("set-cookie");
    for (const cookie of response.headers.getSetCookie()) outgoing.append("set-cookie", cookie);
    outgoing.set("cache-control", "private, no-store");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch {
    return unavailable();
  }
}

function unavailable(): Response {
  return Response.json(
    { error: "service_unavailable", message: "The Enterprise API is unavailable. Try again shortly." },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}
