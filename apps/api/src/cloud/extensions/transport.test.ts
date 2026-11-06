import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  addresses: [{ address: "1.1.1.1", family: 4 }],
  status: 200,
  headers: { "content-type": "application/json" } as Record<string, string>,
  chunks: [] as Buffer[],
  requests: [] as { url: URL; options: Record<string, unknown> }[],
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => fixture.addresses),
}));
vi.mock("node:https", () => ({
  request: vi.fn(
    (
      url: URL,
      options: Record<string, unknown>,
      callback: (response: unknown) => void,
    ) => {
      fixture.requests.push({ url, options });
      const req = new EventEmitter() as EventEmitter & {
        write: () => void;
        end: () => void;
      };
      req.write = () => {};
      req.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          response.statusCode = fixture.status;
          response.headers = fixture.headers;
          let destroyed = false;
          response.destroy = () => {
            destroyed = true;
          };
          callback(response);
          for (const chunk of fixture.chunks) {
            if (destroyed) return;
            response.emit("data", chunk);
          }
          if (!destroyed) response.emit("end");
        });
      };
      return req;
    },
  ),
}));
import { safeHttp, type Plugin } from "./transport.js";
const plugin: Plugin = {
  id: "github",
  name: "GitHub",
  endpoint: "https://api.githubcopilot.com/mcp",
  auth: "token",
  authHosts: [],
  reviewedReads: [],
  docsUrl: "",
  setup: "",
};
describe("Cloud pinned HTTPS transport synthetic socket fixtures", () => {
  beforeEach(() => {
    fixture.addresses = [{ address: "1.1.1.1", family: 4 }];
    fixture.status = 200;
    fixture.headers = { "content-type": "application/json" };
    fixture.chunks = [Buffer.from('{"ok":true}')];
    fixture.requests = [];
  });
  it("pins the vetted public address for both Node lookup callback modes", async () => {
    await safeHttp(plugin, plugin.endpoint, {});
    expect(fixture.requests).toHaveLength(1);
    const options = fixture.requests[0]!.options;
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    const lookup = options.lookup as (
      host: string,
      options: { all?: boolean },
      cb: (...args: unknown[]) => void,
    ) => void;
    let result: unknown[] = [];
    lookup("api.githubcopilot.com", {}, (...args) => (result = args));
    expect(result).toEqual([null, "1.1.1.1", 4]);
    lookup(
      "api.githubcopilot.com",
      { all: true },
      (...args) => (result = args),
    );
    expect(result).toEqual([null, [{ address: "1.1.1.1", family: 4 }]]);
  });
  it("blocks a mixed public/private DNS result before opening a socket", async () => {
    fixture.addresses.push({ address: "169.254.169.254", family: 4 });
    await expect(safeHttp(plugin, plugin.endpoint, {})).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });
  it("rejects redirects without sending credentials to a second origin", async () => {
    fixture.status = 302;
    fixture.headers.location = "https://evil.test";
    await expect(
      safeHttp(plugin, plugin.endpoint, {
        headers: { authorization: "Bearer fixture" },
      }),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
  });
  it("bounds the entire response body before materializing JSON", async () => {
    fixture.chunks = [Buffer.alloc(1048576), Buffer.from("x")];
    await expect(safeHttp(plugin, plugin.endpoint, {})).rejects.toThrow();
  });
  it("decodes UTF-8 across arbitrary network chunk boundaries", async () => {
    const value = Buffer.from('{"text":"नमस्ते"}');
    fixture.chunks = Array.from(value, (b) => Buffer.from([b]));
    const response = await safeHttp(plugin, plugin.endpoint, {});
    expect(JSON.parse(response.body)).toEqual({ text: "नमस्ते" });
  });
  it("stops SSE after the exact matching JSON-RPC response", async () => {
    fixture.headers["content-type"] = "text/event-stream";
    fixture.chunks = [
      Buffer.from('data: {"jsonrpc":"2.0","method":"notice"}\n\n'),
      Buffer.from(
        'data: {"jsonrpc":"2.0","id":"call","result":{"ok":true}}\n\n',
      ),
      Buffer.alloc(1048577),
    ];
    const r = await safeHttp(plugin, plugin.endpoint, { rpcId: "call" });
    expect(JSON.parse(r.body)).toMatchObject({
      id: "call",
      result: { ok: true },
    });
  });
  it("malformed SSE rejects the request without an unhandled data-event exception", async () => {
    fixture.headers["content-type"] = "text/event-stream";
    fixture.chunks = [Buffer.from("data: not-json\n\n")];
    await expect(
      safeHttp(plugin, plugin.endpoint, { rpcId: "call" }),
    ).rejects.toThrow();
  });
});
