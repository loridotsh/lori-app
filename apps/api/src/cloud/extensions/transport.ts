import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { failure, publicAddress } from "./security.js";
export interface Plugin {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
  auth: string;
  authHosts: string[];
  reviewedReads: string[];
  docsUrl: string;
  setup: string;
}
export interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}
export type Http = (
  plugin: Plugin,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    rpcId?: string;
  },
) => Promise<HttpResult>;
export function approvedUrl(plugin: Plugin, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure("cloud_extension_unsafe_url", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    ![new URL(plugin.endpoint).hostname, ...plugin.authHosts].includes(
      url.hostname,
    )
  )
    failure("cloud_extension_unsafe_url", 400);
  return url;
}
/** DNS resolution and connection use the same public address; redirects and environment proxies are never followed. */
export const safeHttp: Http = async (plugin, value, init) => {
  const url = approvedUrl(plugin, value);
  const signal = AbortSignal.any([
    AbortSignal.timeout(30000),
    ...(init.signal ? [init.signal] : []),
  ]);
  const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>(
    (resolve, reject) => {
      const abort = () =>
        reject(new Error("Cloud plugin DNS lookup timed out"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void lookup(url.hostname, { all: true })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    },
  ).catch(() => failure());
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    failure("cloud_extension_unsafe_address", 400);
  const address = addresses[0]!;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    const finish = (v: HttpResult) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Cloud plugin transport failed"));
      }
    };
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: { "user-agent": "Lori-Cloud-Work/1", ...init.headers },
        agent: false,
        family: address.family,
        lookup: ((
          _host: unknown,
          options: { all?: boolean },
          cb: (...args: unknown[]) => void,
        ) =>
          options.all
            ? cb(null, [address])
            : cb(null, address.address, address.family)) as never,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v[0] : v,
          ]),
        );
        if (status >= 300 && status < 400) {
          res.destroy();
          fail();
          return;
        }
        let total = 0;
        let data = "";
        const decoder = new StringDecoder("utf8");
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 1048576) {
            res.destroy();
            fail();
            return;
          }
          data += decoder.write(chunk);
          if (
            init.rpcId &&
            headers["content-type"]?.startsWith("text/event-stream")
          ) {
            let match: Record<string, unknown> | undefined;
            try {
              match = parseSse(data, init.rpcId);
            } catch {
              res.destroy();
              fail();
              return;
            }
            if (match) {
              finish({ status, headers, body: JSON.stringify(match) });
              res.destroy();
            }
          }
        });
        res.on("end", () =>
          finish({ status, headers, body: data + decoder.end() }),
        );
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    if (init.body) req.write(init.body);
    req.end();
  });
};
export function parseSse(
  data: string,
  id: string,
): Record<string, unknown> | undefined {
  for (const event of data.replace(/\r\n/g, "\n").split("\n\n").slice(0, -1)) {
    const text = event
      .split("\n")
      .filter((x) => x.startsWith("data:"))
      .map((x) => x.slice(5).trimStart())
      .join("\n");
    if (!text) continue;
    try {
      const o = JSON.parse(text);
      if (o.id === id) return o;
    } catch {
      failure("cloud_extension_invalid_response");
    }
  }
}
export class McpSession {
  private session: string | undefined;
  private protocol = "2025-11-25";
  constructor(
    private plugin: Plugin,
    private token: string,
    private apiKey: boolean,
    private http: Http = safeHttp,
    private signal?: AbortSignal,
  ) {}
  private endpoint() {
    const u = new URL(this.plugin.endpoint);
    if (this.apiKey && this.plugin.id === "exa") {
      u.search = "";
      u.searchParams.set("exaApiKey", this.token);
    }
    return u.toString();
  }
  async rpc(
    method: string,
    params: unknown = {},
    notification = false,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocol,
    };
    if (this.token && !(this.apiKey && this.plugin.id === "exa"))
      headers.authorization = `Bearer ${this.token}`;
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await this.http(this.plugin, this.endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(!notification ? { id } : {}),
        method,
        params,
      }),
      signal: this.signal,
      rpcId: notification ? undefined : id,
    });
    if (r.status < 200 || r.status >= 300)
      failure(
        r.status === 401
          ? "cloud_extension_reauth_required"
          : "cloud_extension_remote_error",
      );
    const session = r.headers["mcp-session-id"];
    if (session) {
      if (session.length > 512 || !/^[\x21-\x7e]+$/.test(session)) failure();
      this.session = session;
    }
    if (notification) return {};
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(r.body);
    } catch {
      return failure("cloud_extension_invalid_response");
    }
    if (
      obj.id !== id ||
      obj.jsonrpc !== "2.0" ||
      obj.error ||
      !obj.result ||
      typeof obj.result !== "object"
    )
      failure("cloud_extension_remote_error");
    return obj.result as Record<string, unknown>;
  }
  async initialize() {
    const r = await this.rpc("initialize", {
      protocolVersion: this.protocol,
      capabilities: {},
      clientInfo: { name: "lori-cloud-work", version: "1.0.0" },
    });
    if (
      !["2025-11-25", "2025-06-18", "2025-03-26"].includes(
        String(r.protocolVersion),
      )
    )
      failure("cloud_extension_protocol");
    this.protocol = String(r.protocolVersion);
    await this.rpc("notifications/initialized", {}, true);
    return r;
  }
  async list(kind: "tools" | "resources") {
    const items: unknown[] = [];
    let cursor: unknown;
    for (let page = 0; page < 5; page++) {
      const r = await this.rpc(`${kind}/list`, cursor ? { cursor } : {});
      if (!Array.isArray(r[kind])) failure("cloud_extension_invalid_response");
      items.push(...(r[kind] as unknown[]));
      if (items.length > 200) failure("cloud_extension_catalog_limit");
      cursor = r.nextCursor;
      if (!cursor) return items;
      if (typeof cursor !== "string" || cursor.length > 2048) failure();
    }
    return failure("cloud_extension_catalog_limit");
  }
  async close() {
    if (!this.session) return;
    try {
      await this.http(this.plugin, this.endpoint(), {
        method: "DELETE",
        headers: {
          ...(!this.token ? {} : this.apiKey && this.plugin.id === "exa"
            ? { "x-api-key": this.token }
            : { authorization: `Bearer ${this.token}` }),
          "mcp-session-id": this.session,
          "mcp-protocol-version": this.protocol,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(3000),
          ...(this.signal ? [this.signal] : []),
        ]),
      });
    } catch {
      /* Best effort only. Never retry a tool call. */
    }
  }
}
