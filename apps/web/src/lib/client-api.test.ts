import { afterEach, describe, expect, it, vi } from "vitest";
import { clientApi } from "./client-api";
import type { ClientApiError } from "./client-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clientApi", () => {
  it("does not send a JSON content type for requests without a body", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", request);

    await clientApi("/v1/teams/team-1", { method: "DELETE" });

    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.has("content-type")).toBe(false);
  });

  it("defaults requests with a body to JSON", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", request);

    await clientApi("/v1/admin/teams", {
      body: JSON.stringify({ name: "Platform" }),
      method: "POST",
    });

    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("preserves server error codes and support references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "database_schema_unavailable",
            message: "The database schema is not ready.",
            requestId: "req-123",
          }),
          { status: 503 },
        ),
      ),
    );

    await expect(clientApi("/v1/admin/teams")).rejects.toMatchObject({
      code: "database_schema_unavailable",
      message: "The database schema is not ready. Reference: req-123.",
      requestId: "req-123",
      status: 503,
    } satisfies Partial<ClientApiError>);
  });

  it("does not duplicate a support reference already present in the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "internal_error",
            message:
              "The server could not complete the request. Reference: req-123.",
            requestId: "req-123",
          }),
          { status: 500 },
        ),
      ),
    );

    await expect(clientApi("/v1/admin/teams")).rejects.toMatchObject({
      message:
        "The server could not complete the request. Reference: req-123.",
      requestId: "req-123",
    } satisfies Partial<ClientApiError>);
  });

  it("preserves rate-limit recovery timing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "rate_limited",
            message: "Too many requests. Wait before trying again.",
            retryAfterSeconds: 42,
          },
          { headers: { "retry-after": "42" }, status: 429 },
        ),
      ),
    );

    await expect(clientApi("/v1/admin/teams")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 42,
      status: 429,
    } satisfies Partial<ClientApiError>);
  });

  it("classifies network failures consistently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(clientApi("/v1/admin/teams")).rejects.toMatchObject({
      code: "network_unavailable",
      status: 0,
    } satisfies Partial<ClientApiError>);
  });
});
