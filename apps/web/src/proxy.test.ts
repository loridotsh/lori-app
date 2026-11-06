// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

afterEach(() => vi.unstubAllGlobals());
const request = (cookie?: string) =>
  new NextRequest("https://lori.example.test/work/cloud", {
    headers: cookie ? { cookie } : {},
  });
const answer = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("Cloud Work proxy", () => {
  it("only guards the Cloud Work route", () => {
    expect(config.matcher).toEqual(["/work/cloud"]);
  });
  it("redirects with a real, uncached 307 to the same host when Work is off", async () => {
    const fetcher = answer({ contractVersion: 1, enabled: false });
    vi.stubGlobal("fetch", fetcher);
    const response = await proxy(request("session=abc"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://lori.example.test/work?cloud=off",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher.mock.calls[0]![1].headers.cookie).toBe("session=abc");
  });
  it("takes only http or https from the edge and ignores any other scheme or host header", async () => {
    vi.stubGlobal("fetch", answer({ enabled: false }));
    const forwarded = (headers: Record<string, string>) =>
      new NextRequest("http://lori.example.test/work/cloud", {
        headers: { cookie: "session=abc", ...headers },
      });
    const secure = await proxy(forwarded({ "x-forwarded-proto": "https, http" }));
    expect(secure.headers.get("location")).toBe(
      "https://lori.example.test/work?cloud=off",
    );
    vi.stubGlobal("fetch", answer({ enabled: false }));
    const hostile = await proxy(
      forwarded({
        "x-forwarded-proto": "javascript",
        "x-forwarded-host": "evil.test",
      }),
    );
    expect(hostile.headers.get("location")).toBe(
      "http://lori.example.test/work?cloud=off",
    );
  });
  it("lets the request through when Work is on", async () => {
    vi.stubGlobal("fetch", answer({ enabled: true }));
    const response = await proxy(request("session=abc"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
  it.each([
    ["no session", undefined, undefined],
    ["an unauthenticated answer", "session=stale", answer({ error: "unauthenticated" }, 401)],
    ["a server error", "session=abc", answer({}, 503)],
    ["an unreadable answer", "session=abc", answer({ enabled: "no" })],
  ] as const)("fails open to the page for %s", async (_name, cookie, fetcher) => {
    if (fetcher) vi.stubGlobal("fetch", fetcher);
    else vi.stubGlobal("fetch", vi.fn());
    const response = await proxy(request(cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    if (!cookie) expect(fetch).not.toHaveBeenCalled();
  });
  it("fails open when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const response = await proxy(request("session=abc"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
