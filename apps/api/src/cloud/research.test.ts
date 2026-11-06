import { describe, expect, it } from "vitest";
import { CloudResearch, researchSchemas, researchUrl } from "./research.js";
import type { Http } from "./extensions/transport.js";

function fixture(result: unknown = { content: [{ type: "text", text: "Source: https://example.com/news\nVerified source text" }] }) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const http: Http = async (_plugin, url, init) => {
    const body = JSON.parse(init.body ?? "{}");
    calls.push({ url, headers: init.headers ?? {}, body });
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: "2.0", id: body.id,
      result: body.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } } : result }) };
  };
  return { calls, http };
}

describe("built-in public web research", () => {
  it.each([
    "http://example.com", "file:///etc/passwd", "https://localhost", "https://host.local", "https://service.internal",
    "https://127.0.0.1", "https://2130706433", "https://169.254.169.254/latest", "https://10.0.0.1",
    "https://[::1]", "https://[::ffff:127.0.0.1]", "https://user:secret@example.com", "https://example.com:8443",
  ])("rejects private or credential-bearing input %s", async (url) => {
    const f = fixture();
    await expect(new CloudResearch("", f.http).execute("web_fetch", { url }, new AbortController().signal))
      .rejects.toMatchObject({ code: "cloud_research_unsafe_url" });
    expect(f.calls).toHaveLength(0);
  });
  it("normalizes a public URL and bounds model arguments", () => {
    expect(researchUrl("https://example.com/page#part")).toBe("https://example.com/page");
    expect(researchSchemas.web_search.parse({ query: " news " })).toEqual({ query: "news", limit: 5 });
    expect(() => researchSchemas.web_search.parse({ query: "x", limit: 100 })).toThrow();
    expect(() => researchSchemas.web_search.parse({ query: "x", privateFiles: [] })).toThrow();
  });
  it("searches without a plugin login, forwards only public arguments, and retains source metadata", async () => {
    const f = fixture();
    const result = await new CloudResearch("", f.http).execute("web_search",
      { query: "AI announcements October 13 2026", limit: 3, objective: "Find dated official announcements" }, new AbortController().signal);
    expect(result).toMatchObject({ untrusted: true, provider: "Exa", retrievedAt: expect.any(String) });
    expect(f.calls.every((call) => new URL(call.url).hostname === "mcp.exa.ai")).toBe(true);
    expect(f.calls.every((call) => !call.headers.authorization && !call.headers["x-api-key"])).toBe(true);
    expect(f.calls.at(-1)?.body.params).toEqual({ name: "web_search_exa", arguments: {
      query: "AI announcements October 13 2026", numResults: 3, objective: "Find dated official announcements",
    } });
    expect(JSON.stringify(result)).toContain("https://example.com/news");
  });
  it("uses a server-only key in headers and redacts an upstream echo", async () => {
    const key = "synthetic-research-key";
    const f = fixture({ content: [{ type: "text", text: `result ${key}` }] });
    const result = await new CloudResearch(key, f.http).execute("web_fetch", { url: "https://example.com/page" }, new AbortController().signal);
    expect(f.calls.every((call) => call.headers["x-api-key"] === key && !call.url.includes(key))).toBe(true);
    expect(f.calls.at(-1)?.body.params).toEqual({ name: "web_fetch_exa", arguments: { urls: ["https://example.com/page"], maxCharacters: 24000 } });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([{ isError: true, content: [{ type: "text", text: "rate limited" }] }, { content: [] }, {}])(
    "reports upstream errors or malformed results as failures", async (result) => {
      const f = fixture(result);
      await expect(new CloudResearch("", f.http).execute("web_search", { query: "news" }, new AbortController().signal))
        .rejects.toMatchObject({ code: "cloud_research_unavailable" });
    },
  );
  it("recovers from one passing failure", async () => {
    const good = fixture();
    let attempts = 0;
    const flaky: Http = async (plugin, url, init) => {
      if (JSON.parse(init.body ?? "{}").method === "tools/call" && ++attempts === 1)
        return { status: 503, headers: {}, body: "" };
      return good.http(plugin, url, init);
    };
    const result = await new CloudResearch("", flaky).execute("web_search", { query: "news" }, new AbortController().signal);
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ provider: "Exa" });
  });
  it("does not retry a reached quota", async () => {
    const f = fixture({ content: [{ type: "text", text: "You've hit Exa's free MCP rate limit for today." }] });
    await expect(new CloudResearch("", f.http).execute("web_search", { query: "news" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "cloud_research_rate_limited" });
    expect(f.calls.filter((call) => call.body.method === "tools/call")).toHaveLength(1);
  });
  it("does not send a cancelled request", async () => {
    const f = fixture();
    await expect(new CloudResearch("", f.http).execute("web_search", { query: "news" }, AbortSignal.abort())).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("recognizes the real provider's text-only quota failure instead of recording success", async () => {
    const f = fixture({ content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key." }] });
    await expect(new CloudResearch("", f.http).execute("web_search", { query: "news" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "cloud_research_rate_limited" });
  });
});
