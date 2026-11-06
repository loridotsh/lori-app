import type { WorkService } from "./work-service.js";
import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { UsageAnalyticsService } from "../usage/service.js";
import type { EnrollmentService } from "./enrollment-service.js";
import type { ProviderGatewayService } from "./provider-gateway-service.js";
import { IdentityError, type IdentityService } from "./identity-service.js";
import { assertBrowserOrigin } from "./request-origin.js";
import {
  PolicyUpdateCapacityError,
  type DesktopUpdateNotification,
  type DesktopPolicyUpdates,
} from "./policy-updates.js";

const PlatformSchema = z.enum(["macos", "windows", "linux"]);
const PkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const PkceVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9\-._~]+$/);
const OAuthStateSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9\-._~]+$/);
const AuthorizationCodeSchema = z
  .string()
  .min(40)
  .max(160)
  .regex(/^lec_[A-Za-z0-9_-]+$/);
const RefreshTokenSchema = z
  .string()
  .min(40)
  .max(160)
  .regex(/^ler_[A-Za-z0-9_-]+$/);

function desktopBootstrapEtag(
  policyEtag: string,
  usagePolicy:
    { enabled: boolean; epoch: string; startedAt: string } | undefined,
  workSchema?: number,
): string {
  if (!usagePolicy && !workSchema) return policyEtag;
  const digest = createHash("sha256")
    .update(policyEtag)
    .update("\0")
    .update(usagePolicy?.enabled ? "1" : "0")
    .update("\0")
    .update(usagePolicy?.epoch ?? "")
    .update("\0")
    .update(usagePolicy?.startedAt ?? "")
    .update(workSchema ? `\0work-schema-${workSchema}` : "")
    .digest("base64url")
    .slice(0, 32);
  return `"lori-bootstrap-v1-${digest}"`;
}
const CatalogItemSchema = z
  .object({
    enabled: z.boolean(),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    type: z.enum(["app", "plugin", "provider", "skill"]),
  })
  .strict();
const DesktopInventoryItemSchema = z
  .object({
    enabled: z.boolean(),
    enabledAgents: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(16),
    id: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((id) => !/[\u0000-\u001F\u007F]/.test(id)),
    name: z.string().trim().min(1).max(256),
    organizationManaged: z.boolean(),
    type: z.enum(["app", "plugin", "provider", "skill"]),
  })
  .strict();
const DesktopInventoryReportSchema = z
  .object({
    items: z.array(DesktopInventoryItemSchema).max(1_000),
    policyRevision: z.number().int().positive(),
    syncError: z.string().max(2_000).nullable(),
    syncStatus: z.enum(["synced", "error"]),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    value.items.forEach((item, index) => {
      const identity = `${item.type}:${item.id}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Desktop inventory items must have unique identities.",
          path: ["items", index],
        });
      }
      identities.add(identity);
      if (new Set(item.enabledAgents).size !== item.enabledAgents.length) {
        context.addIssue({
          code: "custom",
          message: "Enabled coding tools must be unique.",
          path: ["items", index, "enabledAgents"],
        });
      }
    });
    if (value.syncStatus === "synced" && value.syncError !== null) {
      context.addIssue({
        code: "custom",
        message: "A successful inventory report cannot include a sync error.",
        path: ["syncError"],
      });
    }
    if (value.syncStatus === "error" && !value.syncError?.trim()) {
      context.addIssue({
        code: "custom",
        message: "A failed inventory report must include the sync error.",
        path: ["syncError"],
      });
    }
  });
const PersonalInstallationsSchema = z
  .object({
    plugins: z.boolean(),
    providers: z.boolean(),
    skills: z.boolean(),
  })
  .strict();
const PersonalInstallationOverridesSchema = z
  .object({
    plugins: z.boolean().nullable(),
    providers: z.boolean().nullable(),
    skills: z.boolean().nullable(),
  })
  .strict();
const LoopbackCallbackSchema = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const callback = new URL(value);
      const port = Number(callback.port);
      return (
        callback.protocol === "http:" &&
        callback.hostname === "127.0.0.1" &&
        Number.isInteger(port) &&
        port >= 1024 &&
        port <= 65_535 &&
        callback.username === "" &&
        callback.password === "" &&
        callback.search === "" &&
        callback.hash === "" &&
        /^\/enroll\/[A-Za-z0-9_-]{43}$/.test(callback.pathname)
      );
    } catch {
      return false;
    }
  }, "The desktop callback address is invalid.");

function assertProtocol(version: number | string | string[] | undefined): void {
  if (Array.isArray(version) || Number(version) !== DESKTOP_PROTOCOL_VERSION) {
    throw new IdentityError(
      426,
      "unsupported_desktop_protocol",
      `Lori desktop protocol ${DESKTOP_PROTOCOL_VERSION} is required.`,
    );
  }
}

export function registerEnrollmentRoutes(
  app: FastifyInstance,
  enrollment: EnrollmentService,
  identity: IdentityService,
  config: AppConfig,
  providerGateway?: ProviderGatewayService,
  policyUpdates?: DesktopPolicyUpdates,
  usageAnalytics?: UsageAnalyticsService,
  work?: WorkService,
): void {
  app.get("/v1/policy", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return enrollment.getPolicy(request.headers);
  });

  app.get("/v1/admin/catalog", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return enrollment.getCatalog(request.headers);
  });

  app.get("/v1/admin/policy", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return enrollment.getOrganizationPolicy(request.headers);
  });

  app.patch("/v1/admin/policy", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        managedCatalog: z.array(CatalogItemSchema).max(500),
        personalInstallations: PersonalInstallationsSchema,
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return enrollment.updatePolicy(
      request.headers,
      body.expectedRevision,
      body.personalInstallations,
      body.managedCatalog,
    );
  });

  app.get("/v1/admin/policy/delegation", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return enrollment.getCodeDelegation(request.headers);
  });

  app.put("/v1/admin/policy/delegation", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        delegation: z.unknown(),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return enrollment.updateCodeDelegation(
      request.headers,
      body.expectedRevision,
      body.delegation as Parameters<EnrollmentService["updateCodeDelegation"]>[2],
    );
  });

  app.get("/v1/admin/members/:id/policy", async (request, reply) => {
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .parse(request.params);
    reply.header("cache-control", "private, no-store");
    return enrollment.getMemberPolicy(request.headers, id);
  });

  app.patch("/v1/admin/members/:id/policy", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .parse(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        overrides: z
          .object({
            managedCatalog: z.array(CatalogItemSchema).max(500),
            personalInstallations: PersonalInstallationOverridesSchema,
          })
          .strict(),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return enrollment.updateMemberPolicy(
      request.headers,
      id,
      body.expectedRevision,
      body.overrides,
    );
  });

  app.delete("/v1/admin/members/:id/policy", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .parse(request.params);
    const query = z
      .object({ expectedRevision: z.coerce.number().int().positive() })
      .strict()
      .parse(request.query);
    reply.header("cache-control", "no-store");
    return enrollment.resetMemberPolicy(
      request.headers,
      id,
      query.expectedRevision,
    );
  });

  app.post("/v1/enrollment/authorize", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(
      `enrollment-authorize:${request.ip}`,
      30,
      60,
    );
    const body = z
      .object({
        appVersion: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/),
        codeChallenge: PkceChallengeSchema,
        callbackUrl: LoopbackCallbackSchema.optional(),
        deviceName: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[^\u0000-\u001F\u007F]+$/),
        expectedOrganizationId: z.string().min(1).max(64).optional(),
        platform: PlatformSchema,
        state: OAuthStateSchema.optional(),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    reply.code(201);
    return enrollment.authorize(request.headers, body);
  });

  app.post("/v1/enrollment/token", async (request, reply) => {
    await identity.enforceRateLimit(`enrollment-token:${request.ip}`, 60, 60);
    const body = z
      .object({
        code: AuthorizationCodeSchema,
        codeVerifier: PkceVerifierSchema,
        protocolVersion: z.number().int(),
      })
      .strict()
      .parse(request.body);
    assertProtocol(body.protocolVersion);
    reply.header("cache-control", "no-store");
    return enrollment.exchange({
      code: body.code,
      codeVerifier: body.codeVerifier,
    });
  });

  app.post("/v1/enrollment/refresh", async (request, reply) => {
    await identity.enforceRateLimit(
      `enrollment-refresh:${request.ip}`,
      120,
      60,
    );
    const body = z
      .object({
        protocolVersion: z.number().int(),
        refreshToken: RefreshTokenSchema,
      })
      .strict()
      .parse(request.body);
    assertProtocol(body.protocolVersion);
    reply.header("cache-control", "no-store");
    return enrollment.refresh(body.refreshToken);
  });

  app.get("/v1/desktop/bootstrap", async (request, reply) => {
    assertProtocol(request.headers["x-lori-protocol-version"]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await enrollment.bootstrap(request.headers.authorization);
      const usagePolicy = usageAnalytics
        ? await usageAnalytics.desktopPolicy(request.headers.authorization)
        : undefined;
      const workPolicy = work
        ? await work.desktop(request.headers.authorization)
        : undefined;
      const managedProviderGateways = providerGateway
        ? await providerGateway.desktopGatewayMetadata(
            request.headers.authorization,
          )
        : [];
      const workManagedProviderGateways =
        providerGateway && work
          ? await providerGateway.desktopWorkGatewayMetadata(
              request.headers.authorization,
            )
          : [];
      if (workPolicy) {
        const current = await enrollment.currentPolicyRevision(
          result.bootstrap.organization.id,
        );
        if (
          current !== result.bootstrap.policy.revision ||
          current !== workPolicy.revision
        )
          continue;
      }
      const etag = desktopBootstrapEtag(
        result.etag,
        usagePolicy,
        workPolicy?.schemaVersion,
      );
      reply.header("cache-control", "private, no-cache");
      reply.header("etag", etag);
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      return {
        ...result.bootstrap,
        ...(workPolicy ? { workPolicy, workManagedProviderGateways } : {}),
        ...(managedProviderGateways.length ? { managedProviderGateways } : {}),
        ...(usagePolicy ? { usageAnalytics: usagePolicy } : {}),
      };
    }
    throw new IdentityError(
      409,
      "policy_sync_conflict",
      "Organization policy changed during sync. Retry shortly.",
    );
  });

  if (policyUpdates) {
    app.get("/v1/desktop/updates", async (request, reply) => {
      assertProtocol(request.headers["x-lori-protocol-version"]);
      const { afterRevision } = z
        .object({
          afterRevision: z.coerce.number().int().positive(),
        })
        .strict()
        .parse(request.query);
      // Capture the process-wide sequence before authentication so a policy
      // commit or device revocation during the database reads cannot be lost.
      const sequence = policyUpdates.snapshot();
      const state = await enrollment.desktopUpdateState(
        request.headers.authorization,
      );
      reply.header("cache-control", "private, no-store");
      if (state.revision !== afterRevision) {
        return {
          reason: "policy",
          revision: state.revision,
        };
      }

      const scope = {
        deviceId: state.deviceId,
        organizationId: state.organizationId,
      };
      // Confirm after authentication: a committed revision can become visible
      // while the access lookup is in flight, before the wait is registered.
      const confirmedRevision = await enrollment.currentPolicyRevision(
        state.organizationId,
      );
      if (confirmedRevision !== afterRevision) {
        return {
          reason: "policy",
          revision: confirmedRevision,
        };
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      try {
        let update: DesktopUpdateNotification | null;
        try {
          update = await policyUpdates.waitForChange(
            scope,
            sequence,
            25_000,
            controller.signal,
          );
        } catch (error) {
          if (error instanceof PolicyUpdateCapacityError) {
            throw new IdentityError(
              429,
              "live_update_capacity",
              "Too many live update requests are active for this device. Retry shortly.",
              1,
            );
          }
          throw error;
        }
        if (!update) return reply.code(204).send();
        return {
          reason: update.kind,
          ...(update.revision !== undefined
            ? { revision: update.revision }
            : {}),
        };
      } finally {
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abort);
      }
    });
  }

  app.put("/v1/desktop/inventory", async (request, reply) => {
    assertProtocol(request.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(`device-inventory:${request.ip}`, 120, 60);
    const body = DesktopInventoryReportSchema.parse(request.body);
    await enrollment.reportDesktopInventory(
      request.headers.authorization,
      body,
    );
    reply.header("cache-control", "no-store");
    reply.code(204).send();
  });

  app.post("/v1/desktop/disconnect", async (request, reply) => {
    assertProtocol(request.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(`device-mutation:${request.ip}`, 60, 60);
    await enrollment.disconnect(request.headers.authorization);
    reply.header("cache-control", "no-store");
    reply.code(204).send();
  });

  app.get("/v1/devices", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return enrollment.listMyDevices(request.headers);
  });

  app.delete("/v1/devices/:id", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`device-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await enrollment.revokeDevice(request.headers, id, false);
    reply.code(204).send();
  });

  app.get("/v1/admin/devices", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return enrollment.listOrganizationDevices(request.headers);
  });

  app.delete("/v1/admin/devices/:id", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await enrollment.revokeDevice(request.headers, id, true);
    reply.code(204).send();
  });
}
