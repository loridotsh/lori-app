// @vitest-environment node
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyApiRequest } from "./api-proxy";

let upstream: Server;
let origin: string;
const previous = process.env.LORI_API_INTERNAL_URL;
beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(req.url?.startsWith("/api/auth/") ? 201 : 200, {
      "content-type": "application/json",
      "set-cookie": ["session=fixture; HttpOnly; Path=/", "other=fixture; HttpOnly; Path=/"],
    });
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("base64") }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (previous === undefined) delete process.env.LORI_API_INTERNAL_URL;
  else process.env.LORI_API_INTERNAL_URL = previous;
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
describe("runtime API transport", () => {
  it("preserves the enrolled project scope and client version", async () => {
    process.env.LORI_API_INTERNAL_URL = origin;
    const response = await proxyApiRequest(new Request("http://web.test/api/v1/work/cloud/projects", { headers: { "x-lori-project-id": "synthetic-project", "x-lori-project-client-version": "1" } }));
    expect((await response.json()).headers).toMatchObject({ "x-lori-project-id": "synthetic-project", "x-lori-project-client-version": "1" });
  });
  it.each(["/v1/work/provider-gateway/fixture", "/v1/gateway/providers/fixture"])("preserves Anthropic protocol headers through %s", async (gateway) => {
    process.env.LORI_API_INTERNAL_URL = origin;
    const response = await proxyApiRequest(new Request(`http://web.test/api${gateway}/anthropic/v1/messages`, {
      method: "POST", body: "{}", headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "tools-2024-04-04,prompt-caching-2024-07-31",
      },
    }));
    expect((await response.json()).headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "tools-2024-04-04,prompt-caching-2024-07-31",
    });
  });
  it("reads the API origin at runtime and preserves auth path, cookies, status and CSRF origin", async () => {
    process.env.LORI_API_INTERNAL_URL = origin;
    const response = await proxyApiRequest(new Request("http://web.test/api/auth/sign-in/email?callbackURL=%2Fwork", {
      method: "POST", body: '{"synthetic":true}', headers: {
        "content-type": "application/json", "cookie": "private=fixture", "origin": "http://web.test",
        "authorization": "Bearer fixture", "x-forwarded-host": "spoofed.test", "x-injected": "drop",
      },
    }));
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    expect(result.url).toBe("/api/auth/sign-in/email?callbackURL=%2Fwork");
    expect(result.headers).toMatchObject({ origin: "http://web.test", cookie: "private=fixture", authorization: "Bearer fixture" });
    expect(result.headers["x-forwarded-host"]).toBeUndefined();
    expect(result.headers["x-injected"]).toBeUndefined();
    expect(Buffer.from(result.body, "base64").toString()).toBe('{"synthetic":true}');
    process.env.LORI_API_INTERNAL_URL = "http://127.0.0.1:1";
    expect((await proxyApiRequest(new Request("http://web.test/api/health/ready"))).status).toBe(503);
  });
  it("streams binary uploads, bodyless deletes and query strings to the same private origin", async () => {
    process.env.LORI_API_INTERNAL_URL = origin;
    const bytes = new Uint8Array([0, 255, 1, 128]);
    const upload = await proxyApiRequest(new Request("http://web.test/api/v1/work/cloud/files?url=https://other.test", {
      method: "POST", body: bytes, headers: { "content-type": "application/octet-stream", "origin": "http://web.test" },
    }));
    const result = await upload.json();
    expect(result.url).toBe("/v1/work/cloud/files?url=https://other.test");
    expect(result.body).toBe(Buffer.from(bytes).toString("base64"));
    const deletion = await proxyApiRequest(new Request("http://web.test/api/v1/items/1", { method: "DELETE" }));
    expect(await deletion.json()).toMatchObject({ method: "DELETE", body: "", url: "/v1/items/1" });
  });
  it("never forwards worker-only internal routes, however the path is spelled", async () => {
    process.env.LORI_API_INTERNAL_URL = origin;
    for (const path of [
      "/api/v1/internal/work/cloud/claim",
      "/api/v1/internal/",
      "/api/v1/work/../internal/work/cloud/claim",
      "/api/x/%2e%2e/v1/internal/work/cloud/claim",
      "/api/v1/work/%2E%2E/internal/work/cloud/claim",
      "/api/v1/%69nternal/work/cloud/claim",
      "/api/%76%31/internal/work/cloud/claim",
      "/api/v1/%69%6E%74%65%72%6E%61%6C/work/cloud/claim",
    ]) {
      const response = await proxyApiRequest(
        new Request(`http://web.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer worker-secret" },
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found", message: "Not found." });
    }
    // Ordinary routes that merely contain the word still pass through.
    const ok = await proxyApiRequest(new Request("http://web.test/api/v1/work/internal-notes"));
    expect(ok.status).toBe(200);
  });
  it("does not resolve a client-controlled double slash to a credential recipient", async () => {
    process.env.LORI_API_INTERNAL_URL = origin;
    const response = await proxyApiRequest(new Request("http://web.test/api//external.test/path"));
    expect(await response.json()).toMatchObject({ url: "//external.test/path" });
    process.env.LORI_API_INTERNAL_URL = "http://user:secret@127.0.0.1/";
    expect((await proxyApiRequest(new Request("http://web.test/api/v1/system/status"))).status).toBe(503);
  });
});
