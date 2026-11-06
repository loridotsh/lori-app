import { WorkPricingSchema } from "../cloud/pricing.js";
import { cachedWorkModels, modelMetadata } from "./work-model-discovery.js";
import { Readable, Transform } from "node:stream";
import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DesktopPolicyUpdates } from "./policy-updates.js";
import type { AppConfig } from "../config.js";
import { IdentityError, type IdentityService } from "./identity-service.js";
import { assertBrowserOrigin } from "./request-origin.js";
import type {
  ProviderGatewayService,
  AuthorizedProviderGatewayRequest,
} from "./provider-gateway-service.js";

const GatewayIdSchema = z.string().uuid();
const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value));
const ApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value));
const RevisionSchema = z.number().int().positive();
const RequestsPerMinuteSchema = z.number().int().min(1).max(600);

function assertDesktopProtocol(
  value: number | string | string[] | undefined,
): void {
  if (Array.isArray(value) || Number(value) !== DESKTOP_PROTOCOL_VERSION) {
    throw new IdentityError(
      426,
      "unsupported_desktop_protocol",
      `Lori desktop protocol ${DESKTOP_PROTOCOL_VERSION} is required.`,
    );
  }
}

async function assertAdminMutation(
  request: FastifyRequest,
  identity: IdentityService,
  config: AppConfig,
): Promise<void> {
  assertBrowserOrigin(request, config);
  await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
}

/**
 * Coding tools are not perfectly consistent about whether their configured
 * OpenAI base URL includes `/v1`.  The desktop deliberately exposes a `/v1`
 * URL, so canonicalise the path here before authorising or forwarding it.
 *
 * The result is intentionally a fixed, small allow-list.  It is never used as
 * an arbitrary upstream path.
 */
function canonicalGatewayPath(
  route: "anthropic" | "openai",
  path: string,
): string {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (route === "openai") {
    return normalized.replace(/^v1\//, "");
  }
  return normalized;
}

function modelsPath(route: "anthropic" | "openai"): string {
  return route === "anthropic" ? "v1/models" : "models";
}

function allowedPath(
  route: "anthropic" | "openai",
  path: string,
  method: string,
): boolean {
  if (method === "GET") return path === modelsPath(route);
  if (route === "anthropic") {
    return (
      method === "POST" &&
      (path === "v1/messages" || path === "v1/messages/count_tokens")
    );
  }
  return (
    method === "POST" &&
    ["chat/completions", "completions", "embeddings", "responses"].includes(
      path,
    )
  );
}

function requestModel(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IdentityError(
      400,
      "provider_gateway_invalid_request",
      "Organization provider requests must use a JSON object.",
    );
  }
  const value = (body as Record<string, unknown>).model;
  if (typeof value !== "string" || !value.trim()) {
    throw new IdentityError(
      400,
      "provider_gateway_model_required",
      "Choose an allowed model for this organization provider.",
    );
  }
  return value.trim();
}

function forwardedHeaders(
  headers: Record<string, string | string[] | undefined>,
  route: "anthropic" | "openai",
): Headers {
  const result = new Headers();
  const accept = headers.accept;
  if (typeof accept === "string" && accept.length <= 1_024) {
    result.set("accept", accept);
  }
  const contentType = headers["content-type"];
  if (
    typeof contentType === "string" &&
    /^application\/json(?:;|$)/i.test(contentType)
  ) {
    result.set("content-type", contentType);
  } else {
    result.set("content-type", "application/json");
  }
  if (route === "anthropic") {
    for (const header of ["anthropic-version", "anthropic-beta"] as const) {
      const value = headers[header];
      if (typeof value === "string" && value.length <= 1_024) {
        result.set(header, value);
      }
    }
  }
  return result;
}

function safeGatewayQuery(requestUrl: string | undefined): string {
  if ((requestUrl?.length ?? 0) > 4_096) {
    throw new IdentityError(
      400,
      "provider_gateway_invalid_query",
      "The organization provider request query is too long.",
    );
  }
  const incoming = new URL(requestUrl ?? "/", "http://lori.invalid");
  if (incoming.search.length > 2_048) {
    throw new IdentityError(
      400,
      "provider_gateway_invalid_query",
      "The organization provider request query is too long.",
    );
  }
  for (const name of incoming.searchParams.keys()) {
    if (
      /^(?:api[-_]?key|access[-_]?token|authorization|key|token)$/i.test(name)
    ) {
      throw new IdentityError(
        400,
        "provider_gateway_sensitive_query",
        "Provider credentials must not be sent in a request query.",
      );
    }
  }
  return incoming.search;
}

function upstreamUrl(
  target: AuthorizedProviderGatewayRequest,
  route: "anthropic" | "openai",
  path: string,
  query: string,
): URL {
  const base = target.upstreamBaseUrl.replace(/\/+$/, "");
  const lowerBase = base.toLowerCase();
  // Catalog entries retain the upstream's native base URL.  Most OpenAI
  // providers include `/v1`, whereas Google's OpenAI-compatible endpoint
  // ends in `/openai`; Anthropic-compatible routes normally receive `/v1` in
  // the incoming request.  Preserve the native shape without ever trusting a
  // client-supplied upstream URL.
  const upstreamPath =
    route === "openai"
      ? lowerBase.endsWith("/v1") || lowerBase.endsWith("/openai")
        ? path
        : `v1/${path}`
      : lowerBase.endsWith("/v1") && path.startsWith("v1/")
        ? path.slice(3)
        : path;
  const url = new URL(`${base}/${upstreamPath}`);
  url.search = query;
  return url;
}

function applyUpstreamCredential(
  headers: Headers,
  target: AuthorizedProviderGatewayRequest,
  route: "anthropic" | "openai",
): void {
  // The public Anthropic API uses x-api-key.  Other bundled
  // Anthropic-compatible endpoints (for example OpenRouter and Fireworks)
  // use the standard bearer convention.  The client-facing gateway always
  // accepts the short-lived Lori gateway token; the long-lived upstream key is
  // added only here, on the server.
  if (target.providerId === "anthropic" && route === "anthropic") {
    headers.set("x-api-key", target.apiKey);
    return;
  }
  headers.set("authorization", `Bearer ${target.apiKey}`);
}

function workUpstreamHeaders(
  source: Headers,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const contentType = source
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType === "application/json" ||
    contentType === "text/event-stream"
  ) {
    headers["content-type"] = `${contentType}; charset=utf-8`;
  }
  const requestId = source.get("x-request-id");
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  if (
    requestId &&
    requestId.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(requestId) &&
    !requestId.includes(apiKey) &&
    !requestId.includes(escaped)
  ) {
    headers["x-request-id"] = requestId;
  }
  return headers;
}

/** Preserve byte framing/backpressure while suppressing an exact company key,
 * including JSON-escaped echoes and matches split across upstream chunks.
 * With terminateEvents, a stream that stops short of a blank line gets one:
 * some gateways end on "data: [DONE]\n", which strict parsers discard as a
 * truncated event, throwing away an answer that actually finished. */
export function workCredentialRedactor(
  apiKey: string,
  { terminateEvents = false }: { terminateEvents?: boolean } = {},
): Transform {
  const patterns = [
    Buffer.from(apiKey, "utf8"),
    Buffer.from(JSON.stringify(apiKey).slice(1, -1), "utf8"),
  ].filter(
    (pattern, index, all) =>
      pattern.length > 0 &&
      all.findIndex((candidate) => candidate.equals(pattern)) === index,
  );
  const overlap = Math.max(0, ...patterns.map((pattern) => pattern.length - 1));
  const replacement = Buffer.from("[redacted]", "utf8");
  let pending = Buffer.alloc(0);
  const consume = (chunk: Buffer, final: boolean): Buffer => {
    const buffer = Buffer.concat([pending, chunk]);
    const limit = final ? buffer.length : Math.max(0, buffer.length - overlap);
    const output: Buffer[] = [];
    let position = 0;
    while (position < limit) {
      let match = -1;
      let length = 0;
      for (const pattern of patterns) {
        const found = buffer.indexOf(pattern, position);
        if (
          found >= 0 &&
          (match < 0 ||
            found < match ||
            (found === match && pattern.length > length))
        ) {
          match = found;
          length = pattern.length;
        }
      }
      if (match < 0 || match >= limit) {
        output.push(buffer.subarray(position, limit));
        position = limit;
        break;
      }
      output.push(buffer.subarray(position, match), replacement);
      position = match + length;
    }
    // Copy the bounded tail so it cannot retain a large input chunk's backing buffer.
    pending = Buffer.from(buffer.subarray(position));
    return Buffer.concat(output);
  };
  let tail = Buffer.alloc(0);
  const remember = (output: Buffer): Buffer => {
    if (output.length)
      tail = Buffer.from(Buffer.concat([tail, output]).subarray(-2));
    return output;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, remember(consume(chunk, false)));
    },
    flush(callback) {
      const rest = remember(consume(Buffer.alloc(0), true));
      const closing =
        !terminateEvents || !tail.length || tail.equals(Buffer.from("\n\n"))
          ? ""
          : tail.at(-1) === 0x0a
            ? "\n"
            : "\n\n";
      callback(null, Buffer.concat([rest, Buffer.from(closing)]));
    },
  });
}
function workUpstreamError(response: Response): IdentityError {
  const status = response.status;
  const retry = response.headers.get("retry-after");
  const retryAfter =
    status === 429 &&
    retry &&
    /^\d{1,4}$/.test(retry) &&
    Number(retry) >= 1 &&
    Number(retry) <= 3600
      ? Number(retry)
      : undefined;
  if (status === 401 || status === 403)
    return new IdentityError(
      502,
      "provider_gateway_upstream_credential_rejected",
      "The company provider rejected its stored credential. Ask an organization administrator to update the connection.",
    );
  if (status === 429)
    return new IdentityError(
      429,
      "provider_gateway_upstream_rate_limited",
      "The company provider is rate limited. Retry shortly.",
      retryAfter,
    );
  if (status === 413)
    return new IdentityError(
      413,
      "provider_gateway_upstream_request_too_large",
      "The company provider cannot accept this request size. Shorten the conversation or choose another model.",
    );
  if (status >= 400 && status < 500)
    return new IdentityError(
      status,
      "provider_gateway_upstream_request_rejected",
      "The company provider rejected this model or request. Check the selected model and try again.",
    );
  return new IdentityError(
    502,
    "provider_gateway_upstream_unavailable",
    "The company provider is unavailable. Retry shortly.",
  );
}

function pauseUntilAbort(
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function registerProviderGatewayRoutes(
  app: FastifyInstance,
  providers: ProviderGatewayService,
  identity: IdentityService,
  config: AppConfig,
  policyUpdates?: DesktopPolicyUpdates,
): void {
  app.get("/v1/admin/work/provider-gateways", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return providers.listWorkOrganizationGateways(request.headers);
  });
  app.get("/v1/admin/work/provider-gateways/:gatewayId/pricing", async (request, reply) => {
    const { gatewayId } = z.object({ gatewayId: GatewayIdSchema }).parse(request.params);
    reply.header("cache-control", "private, no-store");
    return providers.workGatewayPricing(request.headers, gatewayId);
  });
  app.post("/v1/admin/work/provider-gateways/:gatewayId/pricing", async (request, reply) => {
    await assertAdminMutation(request, identity, config);
    const { gatewayId } = z.object({ gatewayId: GatewayIdSchema }).parse(request.params);
    const body = z.object({ modelId: ModelSchema, pricing: WorkPricingSchema.nullable(), expectedRevision: RevisionSchema }).strict().parse(request.body);
    reply.header("cache-control", "private, no-store");
    return providers.saveWorkGatewayPricing(request.headers, gatewayId, body.modelId, body.pricing, body.expectedRevision);
  });
  app.get("/v1/admin/work/provider-gateways/:gatewayId/models", async (request, reply) => {
    const { gatewayId } = z.object({ gatewayId: GatewayIdSchema }).parse(request.params);
    await identity.enforceRateLimit(`work-model-discovery:${request.ip}`, 30, 60);
    reply.header("cache-control", "private, no-store");
    return providers.discoverWorkGatewayModels(request.headers, gatewayId);
  });
  app.post("/v1/admin/work/provider-gateways", async (request, reply) => {
    await assertAdminMutation(request, identity, config);
    const body = z
      .object({
        providerId: ProviderIdSchema,
        apiKey: ApiKeySchema,
        requestsPerMinute: RequestsPerMinuteSchema.default(60),
        expectedRevision: RevisionSchema,
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "private, no-store");
    reply.code(201);
    return providers.createWorkOrganizationGateway(request.headers, body);
  });
  app.patch(
    "/v1/admin/work/provider-gateways/:gatewayId",
    async (request, reply) => {
      await assertAdminMutation(request, identity, config);
      const { gatewayId } = z
        .object({ gatewayId: GatewayIdSchema })
        .strict()
        .parse(request.params);
      const body = z
        .object({
          apiKey: ApiKeySchema.optional(),
          requestsPerMinute: RequestsPerMinuteSchema.optional(),
          autoModels: z.boolean().optional(),
          expectedRevision: RevisionSchema,
        })
        .strict()
        .refine(
          (value) =>
            value.apiKey !== undefined ||
            value.requestsPerMinute !== undefined ||
            value.autoModels !== undefined,
          "Choose a company provider setting to update.",
        )
        .parse(request.body);
      reply.header("cache-control", "private, no-store");
      return providers.updateWorkOrganizationGateway(
        request.headers,
        gatewayId,
        body,
      );
    },
  );
  app.get("/v1/admin/provider-gateways", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return providers.listOrganizationGateways(request.headers);
  });

  app.get("/v1/admin/provider-gateways/catalog", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return providers.listAvailableGatewayProviders(request.headers);
  });

  app.post("/v1/admin/provider-gateways", async (request, reply) => {
    await assertAdminMutation(request, identity, config);
    const body = z
      .object({
        apiKey: ApiKeySchema,
        enabledModels: z.array(ModelSchema).min(1).max(32),
        expectedRevision: RevisionSchema,
        providerId: ProviderIdSchema,
        requestsPerMinute: RequestsPerMinuteSchema.default(60),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    reply.code(201);
    return providers.createOrganizationGateway(request.headers, body);
  });

  app.patch(
    "/v1/admin/provider-gateways/:gatewayId",
    async (request, reply) => {
      await assertAdminMutation(request, identity, config);
      const { gatewayId } = z
        .object({ gatewayId: GatewayIdSchema })
        .strict()
        .parse(request.params);
      const body = z
        .object({
          apiKey: ApiKeySchema.optional(),
          enabledModels: z.array(ModelSchema).min(1).max(32).optional(),
          expectedRevision: RevisionSchema,
          requestsPerMinute: RequestsPerMinuteSchema.optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.apiKey !== undefined ||
            value.enabledModels !== undefined ||
            value.requestsPerMinute !== undefined,
          "At least one provider setting is required.",
        )
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return providers.updateOrganizationGateway(
        request.headers,
        gatewayId,
        body,
      );
    },
  );

  app.delete(
    "/v1/admin/provider-gateways/:gatewayId",
    async (request, reply) => {
      await assertAdminMutation(request, identity, config);
      const { gatewayId } = z
        .object({ gatewayId: GatewayIdSchema })
        .strict()
        .parse(request.params);
      const { expectedRevision } = z
        .object({ expectedRevision: z.coerce.number().int().positive() })
        .strict()
        .parse(request.query);
      await providers.deleteOrganizationGateway(
        request.headers,
        gatewayId,
        expectedRevision,
      );
      reply.header("cache-control", "no-store");
      reply.code(204).send();
    },
  );

  app.get("/v1/desktop/provider-credentials", async (request, reply) => {
    assertDesktopProtocol(request.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(
      `provider-credentials:${request.ip}`,
      120,
      60,
    );
    reply.header("cache-control", "private, no-store");
    return providers.desktopCredentials(request.headers.authorization);
  });

  app.get("/v1/desktop/work/provider-credentials", async (request, reply) => {
    assertDesktopProtocol(request.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(
      `work-provider-credentials:${request.ip}`,
      120,
      60,
    );
    reply.header("cache-control", "private, no-store");
    return providers.desktopWorkCredentials(request.headers.authorization);
  });

  for (const product of ["code", "work"] as const)
    app.route({
      bodyLimit: 10 * 1024 * 1024,
      method: ["GET", "POST"],
      url:
        product === "code"
          ? "/v1/gateway/providers/:gatewayId/:route/*"
          : "/v1/work/provider-gateway/:gatewayId/:route/*",
      handler: async (request, reply) => {
        const params = z
          .object({
            "*": z.string().min(1).max(256),
            gatewayId: GatewayIdSchema,
            route: z.enum(["anthropic", "openai"]),
          })
          .strict()
          .parse(request.params);
        const path = canonicalGatewayPath(params.route, params["*"]);
        if (!allowedPath(params.route, path, request.method)) {
          throw new IdentityError(
            404,
            "provider_gateway_endpoint_unavailable",
            "This provider endpoint is not available through Lori Enterprise.",
          );
        }
        const query = safeGatewayQuery(request.raw.url);
        const sequence = policyUpdates?.snapshot() ?? 0;
        const target = await providers.authorizeGatewayRequest(
          request.headers.authorization,
          params.gatewayId,
          params.route,
          ...(product === "work" ? ([product] as const) : []),
        );
        await identity.enforceRateLimit(
          `provider-gateway:${target.gatewayId}:${target.deviceId}`,
          target.requestsPerMinute,
          60,
        );
        if (request.method === "GET" && path === modelsPath(params.route)) {
          reply.header("cache-control", "no-store");
          const discovered = product === "work"
            ? await cachedWorkModels({ ...target, protocol: params.route }) : [];
          let pricing = target.workModelPricing;
          if (product === "work") {
            // Recheck authority after network discovery; never widen the assigned model list.
            const current = await providers.authorizeGatewayRequest(request.headers.authorization, params.gatewayId, params.route, "work");
            const allowed = new Set(current.allowedModels);
            target.allowedModels = target.allowedModels.filter((id) => allowed.has(id));
            pricing = current.workModelPricing;
          }
          const data = target.allowedModels.map((id) => ({
            ...(product === "work" ? discovered.find((m) => m.id === id) ?? modelMetadata({ id }, target.providerId) : {}),
            ...(product === "work" && pricing && Object.hasOwn(pricing, id) ? { workPricing: pricing[id] } : {}),
            created: 0,
            id,
            object: "model",
            owned_by: "organization",
          }));
          return params.route === "anthropic"
            ? { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
            : { data, object: "list" };
        }
        const model = requestModel(request.body);
        if (!target.allowedModels.includes(model)) {
          throw new IdentityError(
            403,
            "provider_gateway_model_denied",
            "That model is not enabled for this organization provider.",
          );
        }
        const headers = forwardedHeaders(request.headers, params.route);
        applyUpstreamCredential(headers, target, params.route);
        const controller =
          product === "work" ? new AbortController() : undefined;
        const cancel = () => controller?.abort();
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          cancel();
          request.raw.removeListener("aborted", cancel);
          reply.raw.removeListener("close", cleanup);
        };
        if (controller) {
          request.raw.once("aborted", cancel);
          reply.raw.once("close", cleanup);
          if (request.raw.aborted || reply.raw.destroyed) {
            cleanup();
            throw new IdentityError(
              499,
              "work_request_cancelled",
              "Work request cancelled.",
            );
          }
          // Notifications make revocations prompt; periodic reauthorization also
          // bounds cancellation when LISTEN reconnects or an event is missed.
          void (async () => {
            let afterSequence = sequence;
            while (!controller.signal.aborted) {
              if (policyUpdates) {
                try {
                  const waitingSince = Date.now();
                  const update = await policyUpdates.waitForChange(
                    {
                      deviceId: target.deviceId,
                      organizationId: target.organizationId,
                    },
                    afterSequence,
                    2_000,
                    controller.signal,
                  );
                  if (update) afterSequence = update.sequence;
                  else
                    await pauseUntilAbort(
                      controller.signal,
                      2_000 - (Date.now() - waitingSince),
                    );
                } catch {
                  await pauseUntilAbort(controller.signal, 1_000);
                }
              } else {
                await pauseUntilAbort(controller.signal, 2_000);
              }
              if (controller.signal.aborted) break;
              try {
                const current = await providers.authorizeGatewayRequest(
                  request.headers.authorization,
                  params.gatewayId,
                  params.route,
                  "work",
                );
                if (!current.allowedModels.includes(model)) cancel();
              } catch {
                cancel();
              }
            }
          })().catch(cancel);
        }
        let upstream: Response;
        try {
          upstream = await fetch(
            upstreamUrl(target, params.route, path, query),
            {
              body: JSON.stringify(request.body),
              headers,
              method: request.method,
              redirect: "manual",
              signal: controller
                ? AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(10 * 60 * 1_000),
                  ])
                : AbortSignal.timeout(10 * 60 * 1_000),
            },
          );
        } catch {
          cleanup();
          throw new IdentityError(
            502,
            "provider_gateway_unavailable",
            "The organization provider could not be reached. Try again shortly.",
          );
        }
        if (!upstream.ok) {
          // Upstream authentication errors may echo the submitted company key.
          // Never forward provider error bodies or redirect locations to members.
          const error = workUpstreamError(upstream);
          cleanup();
          await upstream.body?.cancel().catch(() => undefined);
          throw error;
        }
        reply.code(upstream.status);
        reply.headers(workUpstreamHeaders(upstream.headers, target.apiKey));
        reply.header("cache-control", "no-store");
        if (!upstream.body) {
          cleanup();
          return reply.send();
        }
        const source = Readable.fromWeb(upstream.body as never);
        const body = workCredentialRedactor(target.apiKey, {
          terminateEvents: upstream.headers
            .get("content-type")
            ?.startsWith("text/event-stream"),
        });
        source.once("error", () =>
          body.destroy(
            new IdentityError(
              502,
              "provider_gateway_upstream_stream_failed",
              "The company provider stream was interrupted. Retry shortly.",
            ),
          ),
        );
        body.once("close", () => source.destroy());
        source.pipe(body);
        body.once("end", cleanup);
        body.once("close", cleanup);
        body.once("error", cleanup);
        return reply.send(body);
      },
    });
}
