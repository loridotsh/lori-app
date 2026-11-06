import { isIP } from "node:net";
import { z } from "zod";
import { IdentityError } from "../auth/identity-service.js";
import { publicAddress, redact } from "./extensions/security.js";
import { McpSession, safeHttp, type Http, type Plugin } from "./extensions/transport.js";

export const researchSchemas = {
  web_search: z.object({
    query: z.string().trim().min(1).max(1000),
    objective: z.string().trim().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }).strict(),
  web_fetch: z.object({ url: z.string().min(1).max(8192) }).strict(),
};

const provider: Plugin = {
  id: "exa",
  name: "Web research",
  endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
  auth: "none",
  authHosts: [],
  reviewedReads: ["web_search_exa", "web_fetch_exa"],
  docsUrl: "https://exa.ai/mcp",
  setup: "Public web research; authenticated deployments can supply a dedicated Exa key.",
};

/** Only public, credential-free URLs are sent to the reader. The API connects
 * exclusively to the pinned Exa endpoint, never to a model-supplied host. */
export function researchUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw unsafeUrl(); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") ||
      (isIP(host) ? !publicAddress(host) :
        !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)))
    throw unsafeUrl();
  url.hash = "";
  return url.toString();
}
function unsafeUrl() {
  return new IdentityError(400, "cloud_research_unsafe_url", "Only public HTTPS webpages without embedded credentials can be read.");
}

/** Uses the existing bounded, DNS-pinned MCP transport. No member files,
 * plugin credentials, cookies or conversation history enter this request. */
export class CloudResearch {
  constructor(private apiKey = "", private http: Http = safeHttp) {}

  async execute(name: string, raw: Record<string, unknown>, signal: AbortSignal) {
    const fetch = name === "web_fetch";
    let args: Record<string, unknown>;
    if (fetch) {
      const input = researchSchemas.web_fetch.parse(raw);
      args = { urls: [researchUrl(input.url)], maxCharacters: 24000 };
    } else if (name === "web_search") {
      const input = researchSchemas.web_search.parse(raw);
      args = {
        query: input.query,
        numResults: input.limit,
        objective: input.objective ?? "Find relevant primary sources with source URLs and publication dates. Distinguish recent reporting from older background material.",
      };
    } else throw new IdentityError(400, "cloud_research_tool_unknown", "Unknown web research tool.");
    // Use a header rather than putting a deployment credential in a URL.
    const http: Http = (plugin, url, init) => this.http(plugin, url, {
      ...init,
      headers: { ...init.headers, ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
    });
    const session = new McpSession(provider, "", false, http,
      AbortSignal.any([signal, AbortSignal.timeout(45000)]));
    try {
      signal.throwIfAborted();
      await session.initialize();
      const result = await session.rpc("tools/call", {
        name: fetch ? "web_fetch_exa" : "web_search_exa", arguments: args,
      });
      if (result.isError === true) throw new Error("research provider failed");
      const content = z.array(z.object({ type: z.literal("text"), text: z.string() }).strip())
        .min(1).max(50).parse(result.content);
      if (!content.some((item) => item.text.trim())) throw new Error("empty research response");
      // Exa's anonymous quota response is currently delivered as successful
      // MCP text rather than isError. It is not a successful search result.
      if (content.some((item) => /^You've hit Exa's free MCP rate limit\b/.test(item.text.trim())))
        throw new IdentityError(429, "cloud_research_rate_limited",
          "The public web research quota has been reached. An administrator can configure WORK_CLOUD_RESEARCH_API_KEY for dedicated capacity, or you can use a connected research plugin. This request did not verify any sources.");
      return { provider: "Exa", retrievedAt: new Date().toISOString(), untrusted: true,
        content: redact(content, [this.apiKey]) };
    } catch (error) {
      if (error instanceof IdentityError && error.code === "cloud_research_rate_limited") throw error;
      throw new IdentityError(502, "cloud_research_unavailable",
        "Web research is temporarily unavailable or its usage limit was reached. Try another source or a connected research plugin. No current facts were verified by this request.");
    } finally { await session.close(); }
  }
}
