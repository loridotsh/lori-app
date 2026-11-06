import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { IdentityError } from "./identity-service.js";

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Protect browser-cookie mutations from cross-site requests.
 *
 * Modern same-site fetches send Origin. Referer is accepted only as a fallback
 * for browser/navigation clients that omit Origin, and only after reducing it
 * to its parsed origin. Requests with neither signal fail closed.
 */
export function assertBrowserOrigin(
  request: FastifyRequest,
  config: AppConfig,
): void {
  const trustedOrigin = new URL(config.publicUrl).origin;
  const origin = headerValue(request.headers.origin);
  const referer = headerValue(request.headers.referer);
  const candidate = origin ?? referer;

  if (!candidate || originOf(candidate) !== trustedOrigin) {
    throw new IdentityError(
      403,
      "untrusted_origin",
      "This request came from an untrusted origin.",
    );
  }
}
