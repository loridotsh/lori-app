import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "./client-api";
import {
  applyCloudEvent,
  cloudApi,
  cloudError,
  parseCloudEvent,
  readCloudEvents,
  validateCloudSnapshot,
  validateCloudConversationPage,
  validateCloudSubmitResponse,
  validateCloudFile,
  CLOUD_STREAM_IDLE_TIMEOUT_MS,
  CLOUD_STREAM_SNAPSHOT_INTERVAL_MS,
  type CloudEvent,
} from "./cloud-work-api";

const event: CloudEvent = {
  sequence: 2,
  type: "assistant.delta",
  data: { text: "same" },
  createdAt: "2026-10-11T00:00:00Z",
};
it("describes a withheld project without suggesting a server upgrade", () => {
  expect(cloudError(new ClientApiError("project_not_found", "Project not found", 404)))
    .toBe("This project is unavailable or you do not have access.");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Cloud Work replay", () => {
  it("deduplicates sequence IDs without dropping repeated text", () => {
    const initial = { sequence: 1, text: "same" };
    const next = applyCloudEvent(initial, event);
    expect(next).toEqual({ sequence: 2, text: "samesame" });
    expect(applyCloudEvent(next, event)).toBe(next);
    expect(() => applyCloudEvent(initial, { ...event, sequence: 3 })).toThrow(
      "stream_gap",
    );
  });
  it("ignores heartbeats and validates event payloads", () => {
    expect(parseCloudEvent(": heartbeat")).toBeNull();
    expect(
      parseCloudEvent(`id: 2\nevent: work\ndata: ${JSON.stringify(event)}`),
    ).toEqual(event);
    expect(() =>
      parseCloudEvent(
        'event: work\ndata: {"sequence":2,"type":"assistant.delta","data":{"text":42}}',
      ),
    ).toThrow("invalid_event");
  });
  it("rejects malformed tool events before they can break the conversation", () => {
    expect(() =>
      parseCloudEvent(
        `event: work\ndata: ${JSON.stringify({ ...event, type: "tool.requested", data: { invocation: { id: "tool", name: 42 } } })}`,
      ),
    ).toThrow("invalid_event");
    expect(() =>
      validateCloudSnapshot({
        run: {
          id: "run",
          conversationId: "chat",
          gatewayId: "provider",
          modelId: "model",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          status: "running",
          lastSequence: 2,
          errorCode: null,
        },
        assistantText: "Saved",
        toolInvocations: "broken",
      } as never),
    ).toThrow("unreadable response");
  });
  it("rejects incomplete successful responses before conversation or draft state changes", () => {
    for (const value of [null, {}, { conversations: [null], nextCursor: null }, { conversations: [], nextCursor: 42 }])
      expect(() => validateCloudConversationPage(value)).toThrow("unreadable response");
    expect(validateCloudConversationPage({ conversations: [], nextCursor: null })).toEqual({ conversations: [], nextCursor: null });
    expect(() => validateCloudSubmitResponse({})).toThrow("unreadable response");
    expect(() => validateCloudFile({ id: "file" })).toThrow("unreadable response");
    const conversation = { id: "chat", title: "Draft", revision: 1, createdAt: event.createdAt, updatedAt: event.createdAt };
    const run = { id: "run", conversationId: "another-chat", gatewayId: "provider", modelId: "model", status: "queued", lastSequence: 0, errorCode: null, createdAt: event.createdAt, updatedAt: event.createdAt };
    expect(() => validateCloudSubmitResponse({ conversation, run })).toThrow("unreadable response");
    expect(validateCloudSubmitResponse({ conversation, run: { ...run, conversationId: "chat" } }).conversation).toBe(conversation);
  });
  it("keeps file and memory recovery errors distinct from an unavailable server route", () => {
    expect(cloudError(new ClientApiError("cloud_file_conflict", "The file changed. Read the current version before editing.", 409))).toContain("The file changed");
    expect(cloudError(new ClientApiError("cloud_memory_not_found", "Memory note was not found.", 404))).toBe("Memory note was not found.");
    expect(cloudError(new ClientApiError("cloud_file_version_limit", "This file reached its version limit. Create a new file.", 413))).toContain("Create a new file");
    expect(cloudError(new ClientApiError("request_failed", "Route not found", 404))).toContain("server update");
  });
  it("distinguishes Cloud setup and feature policy failures from account access denial", () => {
    expect(cloudError(new ClientApiError("cloud_disabled", "Denied", 403))).toContain("worker is not configured");
    expect(cloudError(new ClientApiError("admin_required", "Denied", 403))).toContain("Only an administrator");
    expect(cloudError(new ClientApiError("work_disabled", "Denied", 403))).toContain("review your Work access");
    expect(cloudError(new ClientApiError("cloud_memory_disabled", "Denied", 403))).toContain("memory is disabled");
    expect(cloudError(new ClientApiError("cloud_model_denied", "Denied", 403))).toContain("choose an available model");
    expect(cloudError(new ClientApiError("cloud_access_denied", "Denied", 403))).toBe("Your organization has not granted you Cloud Work access.");
    expect(cloudError(new ClientApiError("session_expired", "Denied", 401))).toContain("Sign in again");
  });
  it("handles split UTF-8 and CRLF frames with same-origin cookies and an integer cursor", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      `event: work\r\ndata: ${JSON.stringify({ ...event, data: { text: "नमस्ते" } })}\r\n\r\n`,
    );
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes)
              controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const received = vi.fn();
    await readCloudEvents("run/id", 1, new AbortController().signal, received);
    expect(received).toHaveBeenCalledExactlyOnceWith({
      ...event,
      data: { text: "नमस्ते" },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/work/cloud/runs/run%2Fid/events?after=1",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
    });
  });
  it("cancels a stalled byte stream so the caller can recover its saved snapshot", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel: cancelled }), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    const result = readCloudEvents(
      "run",
      1,
      new AbortController().signal,
      vi.fn(),
    ).catch((failure) => failure);
    await vi.advanceTimersByTimeAsync(CLOUD_STREAM_IDLE_TIMEOUT_MS);
    expect(await result).toMatchObject({
      code: "stream_snapshot_refresh",
      status: 0,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("refreshes the authoritative snapshot even when heartbeats hide stalled events", async () => {
    vi.useFakeTimers();
    let heartbeat: ReturnType<typeof setInterval>;
    const received = vi.fn();
    const cancelled = vi.fn(() => clearInterval(heartbeat));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              heartbeat = setInterval(
                () =>
                  controller.enqueue(
                    new TextEncoder().encode(": heartbeat\n\n"),
                  ),
                1000,
              );
            },
            cancel: cancelled,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const result = readCloudEvents(
      "run",
      1,
      new AbortController().signal,
      received,
    ).catch((failure) => failure);
    await vi.advanceTimersByTimeAsync(CLOUD_STREAM_SNAPSHOT_INTERVAL_MS);
    expect(await result).toMatchObject({ code: "stream_snapshot_refresh" });
    expect(received).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects a revoked or non-stream response before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("denied", { status: 403 })),
    );
    await expect(
      readCloudEvents("run", 0, new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ status: 403, code: "stream_unavailable" });
  });
  it("keeps the API's refusal code from a refused stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "work_disabled" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      readCloudEvents("run", 0, new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ status: 403, code: "work_disabled" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Bad Code!" }), { status: 403 }),
      ),
    );
    await expect(
      readCloudEvents("run", 0, new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ code: "stream_unavailable" });
  });
});

describe("private conversation listings", () => {
  const seen = async (path: string, init?: RequestInit) => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await cloudApi(path, init);
    return String((fetcher.mock.calls[0] as unknown[])[0]);
  };
  afterEach(() => vi.unstubAllGlobals());
  it("asks for chats outside personal projects, keeping the caller's own query", async () => {
    expect(await seen("/conversations")).toContain("/conversations?placement=unfiled");
    expect(await seen("/conversations?cursor=abc")).toContain("cursor=abc&placement=unfiled");
  });
  it("leaves mutations, project listings and explicit placements alone", async () => {
    expect(await seen("/conversations", { method: "POST", body: "{}" })).not.toContain("placement");
    expect(await seen("/personal-projects/p/conversations?limit=5")).not.toContain("placement");
    expect(await seen("/projects/p/conversations")).not.toContain("placement");
    expect(await seen("/conversations?placement=all")).toContain("placement=all");
  });
});
