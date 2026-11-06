import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "./identity-service.js";
import type { EnrollmentService } from "./enrollment-service.js";
import { IdentityError } from "./identity-service.js";
import {
  WorkPolicySchema,
  WorkModelSchema,
  WorkOverridesSchema,
  type WorkService,
} from "./work-service.js";
import { assertBrowserOrigin } from "./request-origin.js";
import { recordAuditEvent } from "./audit.js";
import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";
const Identifier = z.string().min(1).max(128);
export function registerWorkRoutes(
  app: FastifyInstance,
  work: WorkService,
  identity: IdentityService,
  enrollment: EnrollmentService,
  pool: Pool,
  config: AppConfig,
): void {
  app.get("/v1/work/policy", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    return work.own(req.headers);
  });
  for (const path of ["/v1/work/catalog", "/v1/admin/work/catalog"])
    app.get(path, async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      return work.catalog(req.headers);
    });
  app.get("/v1/admin/work/delegation", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    return work.getDelegation(req.headers);
  });
  app.put("/v1/admin/work/delegation", async (req, reply) => {
    assertBrowserOrigin(req, config);
    await identity.enforceRateLimit(`admin-mutation:${req.ip}`, 60, 60);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        delegation: z.unknown(),
      })
      .strict()
      .parse(req.body);
    reply.header("cache-control", "no-store");
    return work.updateDelegation(
      req.headers,
      body.expectedRevision,
      body.delegation,
    );
  });
  const endpoints = [
    { path: "/v1/admin/work/policy", member: false, team: false },
    {
      path: "/v1/admin/work/members/:memberId/policy",
      member: true,
      team: false,
    },
    { path: "/v1/teams/:teamId/work/policy", member: false, team: true },
    {
      path: "/v1/teams/:teamId/work/members/:memberId/policy",
      member: true,
      team: true,
    },
  ];
  for (const endpoint of endpoints) {
    const scope = (params: unknown) => {
      const p = z
        .object({
          teamId: Identifier.optional(),
          memberId: Identifier.optional(),
        })
        .parse(params);
      return {
        ...(endpoint.team ? { teamId: p.teamId! } : {}),
        ...(endpoint.member ? { memberId: p.memberId! } : {}),
      };
    };
    app.get(endpoint.path, async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      return work.read(req.headers, scope(req.params));
    });
    app.patch(endpoint.path, async (req, reply) => {
      assertBrowserOrigin(req, config);
      await identity.enforceRateLimit(`admin-mutation:${req.ip}`, 60, 60);
      const body = endpoint.member
        ? z
            .object({
              expectedRevision: z.number().int().positive(),
              overrides: WorkOverridesSchema,
            })
            .strict()
            .parse(req.body)
        : z
            .object({
              expectedRevision: z.number().int().positive(),
              policy: WorkPolicySchema,
            })
            .strict()
            .parse(req.body);
      reply.header("cache-control", "no-store");
      return work.update(
        req.headers,
        scope(req.params),
        body.expectedRevision,
        "overrides" in body ? body.overrides : body.policy,
      );
    });
    if (endpoint.member)
      app.delete(endpoint.path, async (req, reply) => {
        assertBrowserOrigin(req, config);
        await identity.enforceRateLimit(`admin-mutation:${req.ip}`, 60, 60);
        const { expectedRevision } = z
          .object({ expectedRevision: z.coerce.number().int().positive() })
          .strict()
          .parse(req.query);
        reply.header("cache-control", "no-store");
        return work.update(
          req.headers,
          scope(req.params),
          expectedRevision,
          null,
        );
      });
  }
  const protocol = (value: unknown) => {
    if (Array.isArray(value) || Number(value) !== DESKTOP_PROTOCOL_VERSION)
      throw new IdentityError(
        426,
        "unsupported_desktop_protocol",
        "Unsupported desktop protocol.",
      );
  };
  app.put("/v1/desktop/work/inventory", async (req, reply) => {
    protocol(req.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(`work-inventory:${req.ip}`, 120, 60);
    const body = z
      .object({
        items: z
          .array(
            z
              .object({
                enabled: z.boolean(),
                enabledAgents: z
                  .array(z.string().regex(/^[a-z0-9-]{1,32}$/))
                  .max(16),
                id: z
                  .string()
                  .trim()
                  .min(1)
                  .max(128)
                  .regex(/^[A-Za-z0-9._:-]+$/),
                name: z.string().trim().min(1).max(256),
                organizationManaged: z.boolean(),
                type: z.enum(["app", "plugin", "provider", "skill"]),
              })
              .strict(),
          )
          .max(1000),
        policyRevision: z.number().int().positive(),
        syncError: z.string().max(2000).nullable(),
        syncStatus: z.enum(["synced", "error"]),
      })
      .strict()
      .parse(req.body);
    const d = await enrollment.authenticatedDevice(req.headers.authorization);
    const policy = await work.effectiveForMember(d.organizationId, d.memberId);
    if (body.policyRevision !== policy.revision)
      throw new IdentityError(
        409,
        "policy_revision_conflict",
        "Refresh Work policy before reporting inventory.",
      );
    // Error details may include local paths or provider response contents. Store only status.
    const report = {
      ...body,
      syncError: body.syncError ? "Work inventory sync failed" : null,
      reportedAt: new Date().toISOString(),
    };
    const updated = await pool.query(
      `UPDATE devices SET work_inventory=$2::jsonb
       WHERE id=$1 AND organization_id=$3 AND revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM member WHERE member.id=$4 AND member."organizationId"=devices.organization_id AND member."userId"=devices.user_id)
         AND EXISTS (SELECT 1 FROM device_sessions WHERE device_sessions.id=$5 AND device_sessions.device_id=devices.id AND device_sessions.revoked_at IS NULL AND device_sessions.access_expires_at>NOW())`,
      [
        d.deviceId,
        JSON.stringify(report),
        d.organizationId,
        d.memberId,
        d.sessionId,
      ],
    );
    if (!updated.rowCount)
      throw new IdentityError(
        401,
        "device_session_expired",
        "The device session is expired or revoked.",
      );
    reply.header("cache-control", "no-store");
    return reply.code(204).send();
  });
  app.post("/v1/desktop/work/audit", async (req, reply) => {
    protocol(req.headers["x-lori-protocol-version"]);
    await identity.enforceRateLimit(`work-audit:${req.ip}`, 120, 60);
    const body = z
      .object({
        events: z
          .array(
            z
              .object({
                eventId: z.string().uuid(),
                action: z.enum([
                  "turn_started",
                  "turn_completed",
                  "turn_cancelled",
                  "turn_failed",
                  "tool_approved",
                  "tool_denied",
                  "policy_applied",
                ]),
                occurredAt: z.iso.datetime({ offset: true }),
                policyRevision: z.number().int().positive(),
                providerId: z
                  .string()
                  .regex(/^[A-Za-z0-9._:-]{1,128}$/)
                  .optional(),
                modelId: WorkModelSchema.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(req.body);
    const d = await enrollment.authenticatedDevice(req.headers.authorization);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const valid = await client.query<{ created_at: Date }>(
        `SELECT devices.created_at FROM organization_policies policies
         JOIN devices ON devices.organization_id=policies.organization_id
         JOIN member ON member."organizationId"=devices.organization_id AND member."userId"=devices.user_id
         JOIN device_sessions sessions ON sessions.device_id=devices.id
         WHERE devices.id=$1 AND devices.organization_id=$2 AND devices.revoked_at IS NULL
           AND member.id=$3 AND sessions.id=$4 AND sessions.revoked_at IS NULL AND sessions.access_expires_at>NOW()
         FOR SHARE OF policies, devices, sessions`,
        [d.deviceId, d.organizationId, d.memberId, d.sessionId],
      );
      if (!valid.rowCount)
        throw new IdentityError(
          403,
          "membership_required",
          "Membership is no longer active.",
        );
      let accepted = 0;
      for (const e of body.events) {
        if (
          Date.parse(e.occurredAt) < valid.rows[0]!.created_at.getTime() ||
          Date.parse(e.occurredAt) > Date.now() + 60000
        )
          throw new IdentityError(
            400,
            "invalid_event_time",
            "Event time is outside the enrolled device window.",
          );
        const inserted = await client.query(
          "INSERT INTO desktop_work_audit_receipts(device_id,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
          [d.deviceId, e.eventId],
        );
        if (!inserted.rowCount) continue;
        await recordAuditEvent(client, {
          action: `work.${e.action}`,
          actorUserId: d.userId,
          organizationId: d.organizationId,
          subjectType: "device",
          subjectId: d.deviceId,
          metadata: {
            occurredAt: e.occurredAt,
            policyRevision: e.policyRevision,
            ...(e.providerId ? { providerId: e.providerId } : {}),
            ...(e.modelId ? { modelId: e.modelId } : {}),
          },
        });
        accepted++;
      }
      await client.query("COMMIT");
      reply.header("cache-control", "no-store");
      return { accepted };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
}
