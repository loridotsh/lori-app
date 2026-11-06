import { clientApi, ClientApiError } from "./client-api";

/** Work forms must always leave their pending state; mutations are never retried automatically. */
export async function workApi<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  try {
    return await clientApi<T>(path, { ...init, signal });
  } catch (error) {
    if (init?.signal?.aborted) {
      throw new ClientApiError(
        "request_cancelled",
        "The request was cancelled.",
        0,
      );
    }
    if (timeout.aborted) {
      throw new ClientApiError(
        "request_timeout",
        "Enterprise took too long to respond. Your changes are still here. Check the latest settings before retrying a save.",
        0,
      );
    }
    if (error instanceof ClientApiError) throw error;
    if (error instanceof SyntaxError) {
      throw new ClientApiError(
        "invalid_response",
        "Enterprise returned an unreadable response. Your changes are still here. Try loading the latest settings.",
        502,
      );
    }
    throw new ClientApiError(
      "request_failed",
      "The request could not finish. Your changes are still here. Try again.",
      0,
    );
  }
}
