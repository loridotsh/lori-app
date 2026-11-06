import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import type { IdentityService } from "./identity-service.js";
import { assertBrowserOrigin } from "./request-origin.js";
import {
  clearOnboardingCookie,
  onboardingCookie,
} from "./onboarding.js";

const EmailSchema = z.string().trim().email().max(320);
const RoleSchema = z.enum(["admin", "member"]);
const TokenSchema = z.string().min(32).max(256);
const AuditQuerySchema = z
  .object({
    action: z.string().trim().max(100).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    q: z.string().trim().max(100).default(""),
  })
  .strict();

async function sendAuthResponse(
  reply: FastifyReply,
  response: Response,
) {
  reply.code(response.status);
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      reply.header(name, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    reply.header("set-cookie", cookies);
  }
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  return reply.send(body);
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  auth: LoriAuth,
  identity: IdentityService,
  config: AppConfig,
): void {
  app.route({
    handler: async (request, reply) => {
      if (request.method === "POST") {
        assertBrowserOrigin(request, config);
      }
      const url = new URL(request.url, config.publicUrl);
      if (
        config.auth.publicSignup &&
        request.method === "POST" &&
        url.pathname === "/api/auth/sign-up/email"
      ) {
        await identity.enforceRateLimit(`sign-up:${request.ip}`, 60, 60 * 60);
      }
      const headers = fromNodeHeaders(request.headers);
      headers.delete("content-length");
      headers.set("x-lori-client-ip", request.ip);
      const body =
        request.method === "GET" || request.body === undefined
          ? undefined
          : typeof request.body === "string"
            ? request.body
            : request.body instanceof Uint8Array
              ? Buffer.from(request.body).toString("utf8")
            : JSON.stringify(request.body);
      const response = await auth.handler(
        new Request(url, {
          body,
          headers,
          method: request.method,
        }),
      );
      return sendAuthResponse(reply, response);
    },
    method: ["GET", "POST"],
    url: "/api/auth/*",
  });

  app.get("/v1/setup/status", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return identity.setupStatus();
  });

  app.post("/v1/setup/claim", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`setup:${request.ip}`, 5, 15 * 60);
    const body = z
      .object({
        email: EmailSchema,
        token: TokenSchema,
      })
      .parse(request.body);
    const claim = await identity.claimSetup(body.token, body.email);
    reply.header(
      "set-cookie",
      onboardingCookie(claim, config.auth.secureCookies),
    );
    return { claimed: true };
  });

  app.post("/v1/setup/complete", async (request, reply) => {
    assertBrowserOrigin(request, config);
    const body = z
      .object({
        organizationName: z.string().trim().min(2).max(100),
      })
      .parse(request.body);
    const viewer = await identity.completeSetup(
      request.headers,
      request.headers.cookie,
      body.organizationName,
    );
    reply.header(
      "set-cookie",
      clearOnboardingCookie(config.auth.secureCookies),
    );
    return viewer;
  });

  app.get("/v1/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return identity.getViewer(request.headers);
  });

  app.get("/v1/workspaces", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return identity.listWorkspaces(request.headers);
  });

  app.post("/v1/workspaces", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`workspace-create:${request.ip}`, 60, 60 * 60);
    const body = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("personal") }).strict(),
        z
          .object({
            kind: z.literal("enterprise"),
            organizationName: z.string().trim().min(2).max(100),
          })
          .strict(),
      ])
      .parse(request.body);
    reply.code(201);
    return identity.createWorkspace(request.headers, body);
  });

  app.post("/v1/workspaces/active", async (request) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`workspace-switch:${request.ip}`, 120, 60);
    const body = z
      .object({ organizationId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return identity.switchWorkspace(request.headers, body.organizationId);
  });

  app.post("/v1/workspaces/active/leave", async (request) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`workspace-leave:${request.ip}`, 30, 60);
    const body = z
      .object({ organizationId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return identity.leaveWorkspace(request.headers, body.organizationId);
  });

  app.get("/v1/join/:token", async (request, reply) => {
    const { token } = z
      .object({ token: TokenSchema })
      .parse(request.params);
    reply.header("cache-control", "no-store");
    return identity.previewJoin(token);
  });

  app.post("/v1/join/:token/claim", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`join-claim:${request.ip}`, 30, 60);
    const { token } = z
      .object({ token: TokenSchema })
      .parse(request.params);
    const claim = await identity.claimJoin(token);
    reply.header(
      "set-cookie",
      onboardingCookie(claim, config.auth.secureCookies),
    );
    return { claimed: true };
  });

  app.post("/v1/join/:token/accept", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`join-accept:${request.ip}`, 20, 60);
    const { token } = z
      .object({ token: TokenSchema })
      .parse(request.params);
    const viewer = await identity.acceptJoin(
      token,
      request.headers,
      request.headers.cookie,
    );
    reply.header(
      "set-cookie",
      clearOnboardingCookie(config.auth.secureCookies),
    );
    return viewer;
  });

  app.get("/v1/admin/people", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return identity.listPeople(request.headers);
  });

  app.get("/v1/admin/audit-events", async (request, reply) => {
    const query = AuditQuerySchema.parse(request.query);
    reply.header("cache-control", "private, no-store");
    return identity.listAuditEvents(request.headers, {
      action: query.action,
      limit: query.limit,
      offset: query.offset,
      query: query.q,
    });
  });

  app.get("/v1/admin/audit-events/export.csv", async (request, reply) => {
    const query = AuditQuerySchema.omit({ limit: true, offset: true }).parse(
      request.query,
    );
    const csv = await identity.exportAuditEvents(request.headers, {
      action: query.action,
      query: query.q,
    });
    reply.header("cache-control", "private, no-store");
    reply.header(
      "content-disposition",
      `attachment; filename="lori-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    reply.type("text/csv; charset=utf-8");
    return csv;
  });

  app.post("/v1/admin/invitations", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const body = z
      .object({
        email: EmailSchema,
        role: RoleSchema,
      })
      .parse(request.body);
    reply.code(201);
    return identity.createInvitation(request.headers, body.email, body.role);
  });

  app.post("/v1/admin/invitations/:id/regenerate", async (request) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return identity.regenerateInvitation(request.headers, id);
  });

  app.delete("/v1/admin/invitations/:id", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await identity.revokeInvitation(request.headers, id);
    reply.code(204).send();
  });

  app.patch("/v1/admin/members/:id", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedRevision, role } = z
      .object({
        expectedRevision: z.number().int().positive().optional(),
        role: RoleSchema,
      })
      .strict()
      .parse(request.body);
    await identity.updateMemberRole(request.headers, id, role, expectedRevision);
    reply.code(204).send();
  });

  app.post("/v1/admin/ownership-transfer", async (request) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        memberId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    return identity.transferOwnership(
      request.headers,
      body.memberId,
      body.expectedRevision,
    );
  });

  app.delete("/v1/admin/members/:id", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // DELETE carries no body; the stale-tab revision travels in the query.
    const { expectedRevision } = z
      .object({ expectedRevision: z.coerce.number().int().positive().optional() })
      .parse(request.query ?? {});
    await identity.removeMember(request.headers, id, expectedRevision);
    reply.code(204).send();
  });
}
