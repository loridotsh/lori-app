import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type {
  ApiErrorResponse,
  HealthStatus,
  OperationalState,
  SystemStatus,
} from "@lori-enterprise/contracts";
import type { AppConfig } from "./config.js";
import type { LoriAuth } from "./auth/auth.js";
import type { EnrollmentService } from "./auth/enrollment-service.js";
import { registerEnrollmentRoutes } from "./auth/enrollment-routes.js";
import {
  IdentityError,
  type IdentityService,
} from "./auth/identity-service.js";
import { registerIdentityRoutes } from "./auth/routes.js";
import { registerTeamRoutes } from "./auth/team-routes.js";
import type { TeamService } from "./auth/team-service.js";
import { registerProviderGatewayRoutes } from "./auth/provider-gateway-routes.js";
import type { ProviderGatewayService } from "./auth/provider-gateway-service.js";
import type { DatabaseHealth } from "./db/database.js";
import type { DesktopPolicyUpdates } from "./auth/policy-updates.js";
import { registerUsageAnalyticsRoutes } from "./usage/routes.js";
import type { UsageAnalyticsService } from "./usage/service.js";
import type { WorkService } from "./auth/work-service.js";
import { registerWorkRoutes } from "./auth/work-routes.js";
import type { Pool } from "pg";
import { CloudWorkService } from "./cloud/service.js";
import { registerCloudWorkRoutes } from "./cloud/routes.js";
import { ZodError } from "zod";

export interface AppDependencies {
  auth?: LoriAuth;
  config: AppConfig;
  database: DatabaseHealth;
  enrollment?: EnrollmentService;
  identity?: IdentityService;
  providerGateway?: ProviderGatewayService;
  policyUpdates?: DesktopPolicyUpdates;
  teamService?: TeamService;
  usageAnalytics?: UsageAnalyticsService;
  work?: WorkService;
  pool?: Pool;
}

export const API_LOG_REDACTION_PATHS = [
  "req.url",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "res.headers.set-cookie",
] as const;

function now(): string {
  return new Date().toISOString();
}

interface ErrorResponseOptions {
  code: string;
  message: string;
  requestId: string;
  retryAfterSeconds?: number;
  statusCode: number;
}

interface DatabaseLikeError {
  code?: unknown;
  statusCode?: unknown;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as DatabaseLikeError).code;
  return typeof code === "string" ? code : undefined;
}

function databaseErrorResponse(
  error: unknown,
  requestId: string,
): ErrorResponseOptions | undefined {
  switch (databaseErrorCode(error)) {
    case "42P01":
    case "42703":
    case "3F000":
      return {
        code: "database_schema_unavailable",
        message:
          "The Enterprise database schema is not ready. Run the database migrations and try again.",
        requestId,
        statusCode: 503,
      };
    case "23503":
      return {
        code: "related_resource_missing",
        message:
          "The related resource no longer exists. Refresh and try again.",
        requestId,
        statusCode: 409,
      };
    case "23505":
      return {
        code: "conflict",
        message:
          "That change conflicts with existing data. Refresh and try again.",
        requestId,
        statusCode: 409,
      };
    case "23514":
      return {
        code: "organization_constraint_violation",
        message:
          "That change violates an organization data constraint. Refresh and try again.",
        requestId,
        statusCode: 409,
      };
    case "40001":
    case "40P01":
      return {
        code: "transaction_conflict",
        message: "The data changed while this request was running. Try again.",
        requestId,
        statusCode: 409,
      };
    case "08000":
    case "08001":
    case "08003":
    case "08004":
    case "08006":
    case "08007":
    case "08P01":
    case "57P01":
    case "57P03":
    case "53300":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
      return {
        code: "database_unavailable",
        message: "The Enterprise database is unavailable. Try again shortly.",
        requestId,
        statusCode: 503,
      };
    default:
      return undefined;
  }
}

function requestParsingErrorResponse(
  error: unknown,
  requestId: string,
): ErrorResponseOptions | undefined {
  const code = databaseErrorCode(error);
  switch (code) {
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
    case "FST_ERR_VALIDATION":
      return {
        code: "invalid_request",
        message: "The request body is invalid.",
        requestId,
        statusCode: 400,
      };
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return {
        code: "request_too_large",
        message: "The request body is too large.",
        requestId,
        statusCode: 413,
      };
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return {
        code: "unsupported_media_type",
        message: "The request content type is not supported.",
        requestId,
        statusCode: 415,
      };
    default:
      return undefined;
  }
}

async function sendError(
  reply: FastifyReply,
  options: ErrorResponseOptions,
): Promise<void> {
  const body: ApiErrorResponse = {
    error: options.code,
    message: options.message,
    requestId: options.requestId,
    ...(options.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: options.retryAfterSeconds }
      : {}),
  };
  if (options.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(options.retryAfterSeconds));
  }
  await reply.code(options.statusCode).send(body);
}

function tlsState(publicUrl: string): OperationalState {
  const url = new URL(publicUrl);

  if (url.protocol === "https:") {
    return "operational";
  }

  return url.hostname === "localhost" || url.hostname === "127.0.0.1"
    ? "not_configured"
    : "degraded";
}

export function buildApp({
  auth,
  config,
  database,
  enrollment,
  identity,
  providerGateway,
  policyUpdates,
  teamService,
  usageAnalytics,
  work,
  pool,
}: AppDependencies): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger:
      config.environment === "test"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [...API_LOG_REDACTION_PATHS],
              censor: "[redacted]",
            },
          },
    trustProxy: config.trustProxy,
  });

  if (auth && identity) {
    registerIdentityRoutes(app, auth, identity, config);
  }
  if (enrollment) {
    if (!identity) {
      throw new Error("Enrollment requires identity services");
    }
    registerEnrollmentRoutes(
      app,
      enrollment,
      identity,
      config,
      providerGateway,
      policyUpdates,
      usageAnalytics,
      work,
    );
  }
  if (teamService) {
    if (!identity) {
      throw new Error("Team service requires identity services");
    }
    registerTeamRoutes(app, teamService, identity, config);
  }
  if (providerGateway) {
    if (!identity) {
      throw new Error("Provider gateway requires identity services");
    }
    registerProviderGatewayRoutes(
      app,
      providerGateway,
      identity,
      config,
      policyUpdates,
    );
  }
  if (usageAnalytics) {
    if (!identity) {
      throw new Error("Usage analytics requires identity services");
    }
    registerUsageAnalyticsRoutes(app, usageAnalytics, identity, config);
  }
  if (work && pool && identity && enrollment)
    registerWorkRoutes(app, work, identity, enrollment, pool, config);
  if (pool && identity && enrollment && work && providerGateway)
    registerCloudWorkRoutes(app, new CloudWorkService(pool,config,identity,enrollment,work,providerGateway));
  app.get("/health/live", async (): Promise<HealthStatus> => ({
    status: "ok",
    timestamp: now(),
  }));

  app.get("/health/ready", async (_request, reply): Promise<HealthStatus> => {
    const ready = await database.check();
    reply.code(ready ? 200 : 503);

    return {
      status: ready ? "ok" : "not_ready",
      timestamp: now(),
    };
  });

  app.get("/v1/system/status", async (): Promise<SystemStatus> => {
    const databaseReady = await database.check();
    const setup = identity ? await identity.setupStatus() : null;

    return {
      capabilities: {
        auditLog: Boolean(identity),
        curatedMarketplace: Boolean(enrollment),
        enrollment: Boolean(enrollment),
        gateway: Boolean(providerGateway),
        sso: false,
        usageAnalytics: Boolean(usageAnalytics && databaseReady),
      },
      deployment: {
        api: "operational",
        authentication:
          setup?.state === "ready" ? "operational" : "not_configured",
        database: databaseReady ? "operational" : "unavailable",
        tls: tlsState(config.publicUrl),
      },
      environment: config.environment,
      generatedAt: now(),
      publicUrl: config.publicUrl,
      version: config.version,
    };
  });

  app.setNotFoundHandler(async (request, reply) => {
    await sendError(reply, {
      code: "not_found",
      message: "The requested endpoint does not exist.",
      requestId: request.id,
      statusCode: 404,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof IdentityError) {
      await sendError(reply, {
        code: error.code,
        message: error.message,
        requestId: request.id,
        retryAfterSeconds: error.retryAfterSeconds,
        statusCode: error.statusCode,
      });
      return;
    }

    if (error instanceof ZodError) {
      await sendError(reply, {
        code: "invalid_request",
        message: "The request contains invalid fields.",
        requestId: request.id,
        statusCode: 400,
      });
      return;
    }

    const classified =
      requestParsingErrorResponse(error, request.id) ??
      databaseErrorResponse(error, request.id);
    const response = classified ?? {
      code: "internal_error",
      message: "The server could not complete the request.",
      requestId: request.id,
      statusCode: 500,
    };
    const logContext = {
      err: error,
      errorCode: databaseErrorCode(error),
      requestId: request.id,
    };
    if (response.statusCode >= 500) {
      request.log.error(logContext, "Request failed");
    } else {
      request.log.warn(logContext, "Request rejected");
    }
    await sendError(reply, response);
  });

  app.addHook("onClose", async () => {
    usageAnalytics?.stopRetentionWorker();
    await policyUpdates?.close();
    await database.close();
  });

  return app;
}
