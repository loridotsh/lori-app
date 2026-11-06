import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHealth } from "../db/database.js";
import { IdentityError } from "./identity-service.js";
import type { DesktopPolicyUpdates } from "./policy-updates.js";
import type { IdentityService } from "./identity-service.js";
import type { ProviderGatewayService } from "./provider-gateway-service.js";
import { workCredentialRedactor } from "./provider-gateway-routes.js";

const config: AppConfig = {
  auth: {
    secret: "test-auth-secret-that-is-at-least-32-characters",
    secureCookies: false,
    setupToken: "test-setup-token-that-is-at-least-32-characters",
  },
  database: {
    host: "127.0.0.1",
    name: "unused",
    password: "test-database-password-at-least-32-characters",
    port: 1,
    ssl: false,
    user: "unused",
  },
  environment: "test",
  gateway: {
    secret: "test-provider-gateway-secret-at-least-32-characters",
  },
  host: "127.0.0.1",
  logLevel: "silent",
  port: 4000,
  publicUrl: "https://lori.acme.com",
  trustProxy: false,
  version: "test",
};

const gatewayId = "a4c06525-82b6-4dac-9397-a28e6e9949f0";

function authorizedTarget(overrides: Record<string, unknown> = {}) {
  return {
    allowedModels: ["gpt-5"],
    apiKey: "upstream-secret",
    deviceId: "device-1",
    organizationId: "organization-1",
    gatewayId,
    providerId: "openai",
    requestsPerMinute: 60,
    upstreamBaseUrl: "https://api.openai.com/v1",
    ...overrides,
  };
}

function createApp(policyUpdates?: DesktopPolicyUpdates) {
  const providers = {
    authorizeGatewayRequest: vi.fn(async () => authorizedTarget()),
    createOrganizationGateway: vi.fn(),
    createWorkOrganizationGateway: vi.fn(),
    updateWorkOrganizationGateway: vi.fn(),
    listWorkOrganizationGateways: vi.fn(async () => ({
      providerGateways: [],
      revision: 1,
    })),
    deleteOrganizationGateway: vi.fn(),
    desktopCredentials: vi.fn(async () => ({ providers: [] })),
    listAvailableGatewayProviders: vi.fn(async () => ({ providers: [] })),
    listOrganizationGateways: vi.fn(async () => ({ providerGateways: [] })),
    updateOrganizationGateway: vi.fn(),
  } as unknown as ProviderGatewayService;
  const identity = {
    enforceRateLimit: vi.fn(async () => undefined),
  } as unknown as IdentityService;
  const database: DatabaseHealth = {
    check: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };
  const app = buildApp({
    config,
    database,
    identity,
    providerGateway: providers,
    policyUpdates,
  });
  return { app, identity, providers };
}

const apps: ReturnType<typeof createApp>["app"][] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("organization provider gateway routes", () => {
  it("returns only currently assigned Work model metadata while Code stays unchanged", async () => {
    const { app, providers } = createApp(); apps.push(app);
    vi.mocked(providers.authorizeGatewayRequest).mockResolvedValue(authorizedTarget({ providerId: "openrouter", upstreamBaseUrl: "https://openrouter.ai/api/v1", apiKey: "metadata-test-key", allowedModels: ["allowed"] }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "allowed", context_length: 100000, max_output_tokens: 8000 }, { id: "not-assigned", context_length: 200000 }] })));
    vi.stubGlobal("fetch", fetcher);
    const work = await app.inject({ method: "GET", url: `/v1/work/provider-gateway/${gatewayId}/openai/v1/models`, headers: { authorization: "Bearer lpg1.test" } });
    expect(work.statusCode).toBe(200);
    expect(work.json().data).toEqual([expect.objectContaining({ id: "allowed", context_length: 100000, max_output_tokens: 8000 })]);
    const code = await app.inject({ method: "GET", url: `/v1/gateway/providers/${gatewayId}/openai/v1/models`, headers: { authorization: "Bearer lpg1.test" } });
    expect(code.json().data).toEqual([{ id: "allowed", created: 0, object: "model", owned_by: "organization" }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("serves assigned Work model metadata on the Anthropic route with configured prices", async () => {
    const { app, providers } = createApp(); apps.push(app);
    const workPricing = { input: 3, output: 15, source: "configured", version: "test", currency: "USD" as const, unit: "perMillionTokens" as const };
    vi.mocked(providers.authorizeGatewayRequest).mockResolvedValue(authorizedTarget({ providerId: "anthropic", upstreamBaseUrl: "https://api.anthropic.com", apiKey: "anthropic-metadata-key", allowedModels: ["claude-assigned"], workModelPricing: { "claude-assigned": workPricing } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-assigned", max_input_tokens: 200000, max_tokens: 64000 }], has_more: false }))));
    const response = await app.inject({ method: "GET", url: `/v1/work/provider-gateway/${gatewayId}/anthropic/v1/models`, headers: { authorization: "Bearer lpg1.test" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ has_more: false, first_id: "claude-assigned", last_id: "claude-assigned", data: [{ id: "claude-assigned", max_input_tokens: 200000, max_output_tokens: 64000, workPricing }] });
  });
  it("rejects an unavailable path before authorizing or forwarding it", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { authorization: "Bearer lpg1.test" },
      method: "POST",
      payload: { model: "gpt-5" },
      url: `/v1/gateway/providers/${gatewayId}/openai/v1/files`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "provider_gateway_endpoint_unavailable",
    });
    expect(providers.authorizeGatewayRequest).not.toHaveBeenCalled();
  });

  it("rejects provider credentials in a query before authorization or forwarding", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      headers: { authorization: "Bearer lpg1.test" },
      method: "POST",
      payload: { model: "gpt-5" },
      url: `/v1/gateway/providers/${gatewayId}/openai/v1/responses?api_key=should-not-leak`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "provider_gateway_sensitive_query",
    });
    expect(providers.authorizeGatewayRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("canonicalizes an OpenAI /v1 request without duplicating the upstream version", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: "response-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      headers: { authorization: "Bearer lpg1.test" },
      method: "POST",
      payload: { input: "hello", model: "gpt-5" },
      url: `/v1/gateway/providers/${gatewayId}/openai/v1/responses?stream=false`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "response-1" });
    expect(providers.authorizeGatewayRequest).toHaveBeenCalledWith(
      "Bearer lpg1.test",
      gatewayId,
      "openai",
    );
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.openai.com/v1/responses?stream=false",
    );
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer upstream-secret",
    );
  });

  it("preserves an OpenAI-compatible upstream base that already ends in /openai", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    vi.mocked(providers.authorizeGatewayRequest).mockResolvedValue(
      authorizedTarget({
        allowedModels: ["gemini-2.5-pro"],
        providerId: "google",
        upstreamBaseUrl:
          "https://generativelanguage.googleapis.com/v1beta/openai",
      }),
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      headers: { authorization: "Bearer lpg1.test" },
      method: "POST",
      payload: { model: "gemini-2.5-pro" },
      url: `/v1/gateway/providers/${gatewayId}/openai/v1/chat/completions`,
    });

    expect(response.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("uses the official Anthropic credential header only on the upstream request", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    vi.mocked(providers.authorizeGatewayRequest).mockResolvedValue(
      authorizedTarget({
        allowedModels: ["claude-sonnet-4-6"],
        providerId: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
      }),
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      headers: {
        authorization: "Bearer lpg1.test",
        "anthropic-version": "2023-06-01",
      },
      method: "POST",
      payload: { max_tokens: 32, model: "claude-sonnet-4-6", messages: [] },
      url: `/v1/gateway/providers/${gatewayId}/anthropic/v1/messages`,
    });

    expect(response.statusCode).toBe(200);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(options?.headers);
    expect(headers.get("x-api-key")).toBe("upstream-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("never forwards a request for a model that the current policy did not allow", async () => {
    const { app } = createApp();
    apps.push(app);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      headers: { authorization: "Bearer lpg1.test" },
      method: "POST",
      payload: { model: "not-enabled" },
      url: `/v1/gateway/providers/${gatewayId}/openai/v1/responses`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "provider_gateway_model_denied",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires same-origin evidence before a browser can store a company key", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: "https://attacker.example" },
      method: "POST",
      payload: {
        apiKey: "sk-company-key",
        enabledModels: ["gpt-5"],
        expectedRevision: 1,
        providerId: "openai",
        requestsPerMinute: 60,
      },
      url: "/v1/admin/provider-gateways",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(providers.createOrganizationGateway).not.toHaveBeenCalled();
  });

  it("requires the desktop protocol before returning scoped credentials", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { authorization: "Bearer lea_device-token" },
      method: "GET",
      url: "/v1/desktop/provider-credentials",
    });

    expect(response.statusCode).toBe(426);
    expect(providers.desktopCredentials).not.toHaveBeenCalled();
  });
});

describe("workCredentialRedactor stream endings", () => {
  async function collect(input: string, terminateEvents: boolean) {
    const stream = workCredentialRedactor("sk-secret", { terminateEvents });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise((resolve) => stream.once("end", resolve));
    stream.end(input);
    await finished;
    return Buffer.concat(chunks).toString("utf8");
  }

  it("closes a final event that stops short of a blank line", async () => {
    expect(await collect('data: {"a":1}\n\ndata: [DONE]\n', true)).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(await collect("data: [DONE]", true)).toBe("data: [DONE]\n\n");
  });

  it("leaves a complete stream, an empty one and non-event bodies alone", async () => {
    expect(await collect("data: [DONE]\n\n", true)).toBe("data: [DONE]\n\n");
    expect(await collect("", true)).toBe("");
    expect(await collect('{"ok":true}', false)).toBe('{"ok":true}');
  });

  it("still redacts the key at the very end of a stream", async () => {
    expect(await collect("data: sk-secret", true)).toBe("data: [redacted]\n\n");
  });
});

describe("Work gateway stream cancellation", () => {
  it("does not start an upstream request after the client aborts during authorization", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    let abortDuringAuthorization = () => {};
    app.addHook("onRequest", async (request) => {
      abortDuringAuthorization = () =>
        Object.defineProperty(request.raw, "aborted", {
          value: true,
          configurable: true,
        });
    });
    vi.mocked(providers.authorizeGatewayRequest).mockImplementationOnce(
      async () => {
        abortDuringAuthorization();
        return authorizedTarget();
      },
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await app.inject({
      method: "POST",
      url: `/v1/work/provider-gateway/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5", stream: true },
    });
    expect(response.statusCode).toBe(499);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an active upstream stream when a committed update revokes its session or model", async () => {
    let notify: () => void = () => {};
    const updates = {
      snapshot: () => 0,
      close: async () => {},
      waitForChange: async () =>
        new Promise((resolve) => {
          notify = () =>
            resolve({
              deviceId: "device-1",
              organizationId: "organization-1",
              kind: "access_revoked",
              sequence: 1,
            });
        }),
    } as DesktopPolicyUpdates;
    const { app, providers } = createApp(updates);
    apps.push(app);
    let denied = false;
    vi.mocked(providers.authorizeGatewayRequest).mockImplementation(
      async () => {
        if (denied)
          throw new IdentityError(
            403,
            "provider_gateway_access_revoked",
            "Access revoked.",
          );
        return authorizedTarget();
      },
    );
    let upstreamAborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            options.signal!.addEventListener(
              "abort",
              () => {
                upstreamAborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        });
        queueMicrotask(() => {
          denied = true;
          notify();
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/work/provider-gateway/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5", stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data: first");
    expect(upstreamAborted).toBe(true);
    expect(providers.authorizeGatewayRequest).toHaveBeenCalledTimes(2);
  });
  it("aborts the upstream when the Work caller disconnects", async () => {
    const { app } = createApp();
    apps.push(app);
    let disconnect: () => void = () => {};
    app.addHook("onRequest", async (request) => {
      disconnect = () => request.raw.emit("aborted");
    });
    let upstreamAborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            options.signal!.addEventListener(
              "abort",
              () => {
                upstreamAborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        });
        queueMicrotask(disconnect);
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    await app.inject({
      method: "POST",
      url: `/v1/work/provider-gateway/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5", stream: true },
    });
    expect(upstreamAborted).toBe(true);
  });
});

describe("Work company provider configuration routes", () => {
  it("accepts key/rate settings only and rejects Code model assignments", async () => {
    const { app, providers } = createApp();
    apps.push(app);
    const headers = { origin: config.publicUrl };
    const payload = {
      providerId: "openai",
      apiKey: "company-test-key",
      expectedRevision: 1,
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/work/provider-gateways",
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(providers.createWorkOrganizationGateway).toHaveBeenCalledWith(
      expect.anything(),
      { ...payload, requestsPerMinute: 60 },
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/work/provider-gateways",
          headers,
          payload: { ...payload, enabledModels: ["code-model"] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/admin/work/provider-gateways/${gatewayId}`,
          headers,
          payload: { expectedRevision: 1, enabledModels: ["code-model"] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/admin/work/provider-gateways/${gatewayId}`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/work/provider-gateways",
          headers: { origin: "https://wrong.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe.each(["/v1/work/provider-gateway", "/v1/gateway/providers"])("Company credential response boundary: %s", (gatewayPath) => {
  it.each([
    {
      status: 401,
      expected: 502,
      code: "provider_gateway_upstream_credential_rejected",
    },
    {
      status: 403,
      expected: 502,
      code: "provider_gateway_upstream_credential_rejected",
    },
    {
      status: 400,
      expected: 400,
      code: "provider_gateway_upstream_request_rejected",
    },
    {
      status: 413,
      expected: 413,
      code: "provider_gateway_upstream_request_too_large",
    },
    {
      status: 429,
      expected: 429,
      code: "provider_gateway_upstream_rate_limited",
    },
    {
      status: 500,
      expected: 502,
      code: "provider_gateway_upstream_unavailable",
    },
    {
      status: 302,
      expected: 502,
      code: "provider_gateway_upstream_unavailable",
    },
  ])(
    "does not expose an upstream error body or redirect for$status",
    async ({ status, expected, code }) => {
      const { app } = createApp();
      apps.push(app);
      const cancelled = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("Incorrect company key: upstream-secret"),
          );
        },
        cancel: cancelled,
      });
      const fetch = vi.fn(
        async (_url: unknown, _options: RequestInit) =>
          new Response(body, {
            status,
            headers: {
              "content-type": "application/json",
              "retry-after": "120",
              location: "https://other.example/upstream-secret",
            },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const response = await app.inject({
        method: "POST",
        url: `${gatewayPath}/${gatewayId}/openai/v1/chat/completions`,
        headers: { authorization: "Bearer lpg1.work" },
        payload: { model: "gpt-5" },
      });
      expect(response.statusCode).toBe(expected);
      expect(response.json().error).toBe(code);
      expect(response.body).not.toContain("upstream-secret");
      expect(response.headers.location).toBeUndefined();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
      if (status === 429) expect(response.headers["retry-after"]).toBe("120");
      else expect(response.headers["retry-after"]).toBeUndefined();
    },
  );
  it("drops unsafe/unbounded upstream retry values", async () => {
    const { app } = createApp();
    apps.push(app);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("upstream-secret", {
            status: 429,
            headers: { "retry-after": "999999999" },
          }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: `${gatewayPath}/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.body).not.toContain("upstream-secret");
  });
  it.each(["upstream-secret", 'company-secret"quoted\\token'])(
    "redacts split-chunk SSE echoes while preserving multibyte framing for%j",
    async (secret) => {
      const { app, providers } = createApp();
      apps.push(app);
      vi.mocked(providers.authorizeGatewayRequest).mockResolvedValue(
        authorizedTarget({ apiKey: secret }),
      );
      const payload = `data: ${JSON.stringify({ error: { message: `हैलो 🌍 ${secret} and ${secret}` } })}\n\n`;
      const bytes = new TextEncoder().encode(payload);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const byte of bytes)
                    controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        ),
      );
      const response = await app.inject({
        method: "POST",
        url: `${gatewayPath}/${gatewayId}/openai/v1/chat/completions`,
        headers: { authorization: "Bearer lpg1.work" },
        payload: { model: "gpt-5", stream: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(response.body.endsWith("\n\n")).toBe(true);
      expect(JSON.parse(response.body.slice(6).trim()).error.message).toBe(
        "हैलो 🌍 [redacted] and [redacted]",
      );
    },
  );
  it("does not reflect company-key echoes in successful response headers", async () => {
    const { app } = createApp();
    apps.push(app);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('data: {"ok":true}\n\n', {
            headers: {
              "content-type": "text/event-stream; company-key=upstream-secret",
              "x-request-id": "upstream-secret",
              "cache-control": "upstream-secret",
            },
          }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: `${gatewayPath}/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5", stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers["x-request-id"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.headers)).not.toContain("upstream-secret");
  });
  it("sanitizes an upstream stream exception before it reaches the response/error handler", async () => {
    const { app } = createApp();
    apps.push(app);
    const logged: unknown[] = [];
    app.addHook("onRequest", async (request) => {
      vi.spyOn(request.log, "error").mockImplementation(
        (...args: unknown[]) => {
          logged.push(args);
        },
      );
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new Error("network failure containing upstream-secret"),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: `${gatewayPath}/${gatewayId}/openai/v1/chat/completions`,
      headers: { authorization: "Bearer lpg1.work" },
      payload: { model: "gpt-5", stream: true },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.body).not.toContain("upstream-secret");
    // Fastify may wrap a pre-header stream failure in its generic internal
    // error. Neither its response nor serialized error/cause may retain the key.
    const serialized = JSON.stringify(logged, (_key, value) =>
      value instanceof Error
        ? {
            message: value.message,
            stack: value.stack,
            cause: (value as Error & { cause?: unknown }).cause,
          }
        : value,
    );
    expect(serialized).not.toContain("upstream-secret");
  });
});
