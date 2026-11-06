import { afterEach, describe, expect, it, vi } from "vitest";
import { workApi } from "./work-api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Work request recovery", () => {
  it("bounds requests and preserves the normal credential transport", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", request);
    await workApi("/v1/admin/work/policy", { method: "PATCH", body: "{}" });
    const options = request.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.credentials).toBe("same-origin");
    expect(request).toHaveBeenCalledOnce();
  });
  it("classifies malformed success responses without exposing their body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>internal detail</html>")),
    );
    await expect(workApi("/v1/admin/work/policy")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });
  it("keeps permission errors and never retries a mutation", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "admin_required",
            message: "Administrator access is required.",
          }),
          { status: 403 },
        ),
    );
    vi.stubGlobal("fetch", request);
    await expect(
      workApi("/v1/admin/work/policy", { method: "PATCH", body: "{}" }),
    ).rejects.toMatchObject({ code: "admin_required", status: 403 });
    expect(request).toHaveBeenCalledOnce();
  });
  it("distinguishes deadline expiry from navigation cancellation", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        timeout.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(workApi("/v1/admin/work/policy")).rejects.toMatchObject({
      code: "request_timeout",
    });
  });
  it("preserves an explicit caller cancellation", async () => {
    const caller = new AbortController();
    caller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(
      workApi("/v1/admin/work/policy", { signal: caller.signal }),
    ).rejects.toMatchObject({ code: "request_cancelled" });
  });
});
