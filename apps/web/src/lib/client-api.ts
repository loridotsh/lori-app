import type { ApiErrorResponse } from "@lori-enterprise/contracts";

export class ClientApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export async function clientApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError";
    const cancelled = name === "AbortError" || init?.signal?.aborted;
    throw new ClientApiError(
      timedOut ? "request_timeout" : cancelled ? "request_cancelled" : "network_unavailable",
      timedOut
        ? "The request timed out. Check your connection and try again."
        : cancelled
          ? "The request was cancelled."
          : "Lori Enterprise could not be reached. Check your connection and try again.",
      0,
    );
  }

  if (!response.ok) {
    const fallback: ApiErrorResponse = {
      error: "request_failed",
      message: "The request could not be completed.",
    };
    const body = (await response.json().catch(() => fallback)) as Partial<ApiErrorResponse>;
    const code = typeof body.error === "string" ? body.error : fallback.error;
    const message =
      typeof body.message === "string" ? body.message : fallback.message;
    const requestId =
      typeof body.requestId === "string" ? body.requestId : undefined;
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const retryAfterSeconds =
      typeof body.retryAfterSeconds === "number" &&
      Number.isFinite(body.retryAfterSeconds) &&
      body.retryAfterSeconds >= 0
        ? Math.ceil(body.retryAfterSeconds)
        : Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0
          ? Math.ceil(retryAfterHeader)
          : undefined;
    const displayMessage =
      requestId &&
      (response.status >= 500 || code.startsWith("database_")) &&
      !message.includes(requestId)
        ? `${message} Reference: ${requestId}.`
        : message;
    throw new ClientApiError(
      code,
      displayMessage,
      response.status,
      requestId,
      retryAfterSeconds,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
