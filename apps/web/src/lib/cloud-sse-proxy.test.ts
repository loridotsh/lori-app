// @vitest-environment node
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/v1/work/cloud/runs/[id]/events/route";

const id = "a1a0f672-d672-4a9c-b565-ad57f41fbf15";
let upstream: Server;
let proxy: Server;
let upstreamUrl: string;
let proxyUrl: string;
let previousEnv: string | undefined;
let closed = 0;
const requests: { url: string; headers: IncomingHttpHeaders }[] = [];
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  previousEnv = process.env.LORI_API_INTERNAL_URL;
  upstream = createServer((request, response) => {
    requests.push({ url: request.url!, headers: request.headers });
    if (request.headers.authorization === "Bearer denied-fixture") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "upstream-private-detail" }));
      return;
    }
    if (request.headers.authorization === "Bearer work-off-fixture") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "work_disabled", message: "upstream-private-detail" }),
      );
      return;
    }
    if (request.headers.authorization === "Bearer hostile-code-fixture") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "<script>alert(1)</script>" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.flushHeaders();
    response.write(
      'id: 2\nevent: work\ndata: {"sequence":2,"type":"run.started","data":{},"createdAt":"2026-10-11T00:00:00Z"}\n\n',
    );
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 50);
    response.once("close", () => {
      clearInterval(timer);
      closed++;
    });
  });
  upstreamUrl = await listen(upstream);
  process.env.LORI_API_INTERNAL_URL = upstreamUrl;
  proxy = createServer(async (request, response) => {
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    const result = await GET(
      new Request(`http://proxy.test${request.url}`, {
        headers,
        signal: abort.signal,
      }),
      { params: Promise.resolve({ id }) },
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.flushHeaders();
    if (!result.body) {
      response.end();
      return;
    }
    const reader = result.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        response.write(part.value);
      }
    } catch {
      /* a browser disconnect aborts the upstream reader */
    } finally {
      await reader.cancel().catch(() => {});
      response.end();
    }
  });
  proxyUrl = await listen(proxy);
});
afterAll(async () => {
  if (previousEnv === undefined) delete process.env.LORI_API_INTERNAL_URL;
  else process.env.LORI_API_INTERNAL_URL = previousEnv;
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => proxy.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
});
describe("Cloud SSE HTTP proxy", () => {
  it("delivers bytes to curl while the upstream stream is still open", async () => {
    const started = Date.now();
    let firstByte: number | undefined;
    let output = "";
    const curl = spawn("curl", [
      "--silent",
      "--no-buffer",
      "--max-time",
      "1",
      `${proxyUrl}/api/v1/work/cloud/runs/${id}/events?after=1`,
    ]);
    curl.stdout.on("data", (chunk) => {
      firstByte ??= Date.now() - started;
      output += chunk.toString();
    });
    const [exit] = await once(curl, "close");
    expect(exit).toBe(28);
    expect(firstByte).toBeLessThan(800);
    expect(output).toContain('"type":"run.started"');
    expect(output).toContain(": heartbeat");
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0));
  });
  it("preserves private streaming headers and forwards only the approved request metadata", async () => {
    const response = await fetch(
      `${proxyUrl}/api/v1/work/cloud/runs/${id}/events`,
      {
        headers: {
          Cookie: "fixture-session=synthetic",
          Authorization: "Bearer synthetic-fixture",
          "Last-Event-ID": "7",
          "X-Lori-Protocol-Version": "1",
          "X-Lori-Project-Client-Version": "1",
          "X-Lori-Project-Id": id,
          "X-Forwarded-Host": "untrusted.test",
          "X-Injected": "do-not-forward",
        },
      },
    );
    expect(response.headers.get("content-encoding")).toBe("identity");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    const request = requests.at(-1)!;
    expect(request.url).toBe(`/v1/work/cloud/runs/${id}/events`);
    expect(request.headers).toMatchObject({
      cookie: "fixture-session=synthetic",
      authorization: "Bearer synthetic-fixture",
      "last-event-id": "7",
      "x-lori-protocol-version": "1",
      "x-lori-project-client-version": "1",
      "x-lori-project-id": id,
      "accept-encoding": "identity",
    });
    expect(request.headers["x-injected"]).toBeUndefined();
    expect(request.headers["x-forwarded-host"]).toBeUndefined();
  });
  it("rejects arbitrary destinations and malformed replay cursors before requesting upstream", async () => {
    const count = requests.length;
    for (const query of [
      "?url=https://untrusted.test",
      "?after=-1",
      "?after=1&after=2",
      "?after=9999999999999999",
    ]) {
      const response = await GET(
        new Request(`http://proxy.test/events${query}`),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
    }
    const invalid = await GET(new Request("http://proxy.test/events"), {
      params: Promise.resolve({ id: "../../admin" }),
    });
    expect(invalid.status).toBe(400);
    expect(requests).toHaveLength(count);
  });
  it("preserves access denial without exposing upstream details or redirecting credentials", async () => {
    const response = await GET(
      new Request("http://proxy.test/events", {
        headers: { Authorization: "Bearer denied-fixture" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("upstream-private-detail");
  });
  it("keeps a plain refusal code so the client can tell Work being off from a lost session", async () => {
    const off = await GET(
      new Request("http://proxy.test/events", {
        headers: { Authorization: "Bearer work-off-fixture" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(off.status).toBe(403);
    const body = await off.json();
    expect(body.error).toBe("work_disabled");
    expect(JSON.stringify(body)).not.toContain("upstream-private-detail");
    const hostile = await GET(
      new Request("http://proxy.test/events", {
        headers: { Authorization: "Bearer hostile-code-fixture" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect((await hostile.json()).error).toBe("stream_unavailable");
  });
});
