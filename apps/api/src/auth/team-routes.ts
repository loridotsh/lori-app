import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "./identity-service.js";
import { assertBrowserOrigin } from "./request-origin.js";
import type { TeamService } from "./team-service.js";

const TeamIdentifierSchema = z.string().min(1).max(128);
const MemberIdentifierSchema = z.string().min(1).max(128);
const TeamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\u0000-\u001F\u007F]+$/);
const TeamSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const TeamDescriptionSchema = z
  .string()
  .trim()
  .max(500)
  .nullable();
const TeamRoleSchema = z.enum(["team_admin", "member"]);
const CatalogItemSchema = z
  .object({
    enabled: z.boolean(),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    type: z.enum(["app", "plugin", "provider", "skill"]),
  })
  .strict();
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

function teamParams(value: unknown): { teamId: string } {
  return z
    .object({ teamId: TeamIdentifierSchema })
    .strict()
    .parse(value);
}

function listOptions(value: unknown): {
  limit: number;
  offset: number;
  query: string;
} {
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      q: z.string().trim().max(100).default(""),
    })
    .strict()
    .parse(value);
  return { limit: parsed.limit, offset: parsed.offset, query: parsed.q };
}

async function assertMutation(
  request: FastifyRequest,
  identity: IdentityService,
  config: AppConfig,
): Promise<void> {
  assertBrowserOrigin(request, config);
  await identity.enforceRateLimit(`admin-mutation:${request.ip}`, 60, 60);
}

export function registerTeamRoutes(
  app: FastifyInstance,
  teams: TeamService,
  identity: IdentityService,
  config: AppConfig,
): void {
  app.get("/v1/admin/teams", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return teams.listTeams(request.headers);
  });

  app.post("/v1/admin/teams", async (request, reply) => {
    await assertMutation(request, identity, config);
    const body = z
      .object({
        description: TeamDescriptionSchema.optional(),
        name: TeamNameSchema,
        slug: TeamSlugSchema,
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    reply.code(201);
    return teams.createTeam(request.headers, body);
  });

  app.get("/v1/teams/:teamId", async (request, reply) => {
    const { teamId } = teamParams(request.params);
    reply.header("cache-control", "private, no-store");
    return teams.getTeam(request.headers, teamId);
  });

  app.patch("/v1/teams/:teamId", async (request, reply) => {
    await assertMutation(request, identity, config);
    const { teamId } = teamParams(request.params);
    const body = z
      .object({
        description: TeamDescriptionSchema.optional(),
        name: TeamNameSchema.optional(),
      })
      .strict()
      .refine(
        (value) => value.name !== undefined || value.description !== undefined,
        "At least one team field is required.",
      )
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return teams.updateTeam(request.headers, teamId, body);
  });

  app.delete("/v1/teams/:teamId", async (request, reply) => {
    await assertMutation(request, identity, config);
    const { teamId } = teamParams(request.params);
    await teams.deleteTeam(request.headers, teamId);
    reply.code(204).send();
  });

  app.get("/v1/teams/:teamId/members", async (request, reply) => {
    const { teamId } = teamParams(request.params);
    reply.header("cache-control", "private, no-store");
    return teams.listTeamMembers(
      request.headers,
      teamId,
      listOptions(request.query),
    );
  });

  app.get(
    "/v1/teams/:teamId/eligible-members",
    async (request, reply) => {
      const { teamId } = teamParams(request.params);
      reply.header("cache-control", "private, no-store");
      return teams.listEligibleTeamMembers(
        request.headers,
        teamId,
        listOptions(request.query),
      );
    },
  );

  app.post("/v1/teams/:teamId/members", async (request, reply) => {
    await assertMutation(request, identity, config);
    const { teamId } = teamParams(request.params);
    const body = z
      .object({
        memberId: MemberIdentifierSchema,
        role: TeamRoleSchema.default("member"),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    reply.code(201);
    return teams.addTeamMember(
      request.headers,
      teamId,
      body.memberId,
      body.role,
    );
  });

  app.post("/v1/teams/:teamId/members/bulk", async (request, reply) => {
    await assertMutation(request, identity, config);
    const { teamId } = teamParams(request.params);
    const body = z
      .object({
        memberIds: z.array(MemberIdentifierSchema).min(1).max(100),
        role: TeamRoleSchema.default("member"),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    reply.code(201);
    return teams.addTeamMembers(
      request.headers,
      teamId,
      body.memberIds,
      body.role,
    );
  });

  app.patch(
    "/v1/teams/:teamId/members/:teamMemberId",
    async (request, reply) => {
      await assertMutation(request, identity, config);
      const { teamId, teamMemberId } = z
        .object({
          teamId: TeamIdentifierSchema,
          teamMemberId: MemberIdentifierSchema,
        })
        .strict()
        .parse(request.params);
      const body = z
        .object({ role: TeamRoleSchema })
        .strict()
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return teams.updateTeamMemberRole(
        request.headers,
        teamId,
        teamMemberId,
        body.role,
      );
    },
  );

  app.delete(
    "/v1/teams/:teamId/members/:teamMemberId",
    async (request, reply) => {
      await assertMutation(request, identity, config);
      const { teamId, teamMemberId } = z
        .object({
          teamId: TeamIdentifierSchema,
          teamMemberId: MemberIdentifierSchema,
        })
        .strict()
        .parse(request.params);
      await teams.removeTeamMember(request.headers, teamId, teamMemberId);
      reply.code(204).send();
    },
  );

  app.get("/v1/teams/:teamId/policy", async (request, reply) => {
    const { teamId } = teamParams(request.params);
    reply.header("cache-control", "private, no-store");
    return teams.getTeamPolicy(request.headers, teamId);
  });

  app.post("/v1/teams/:teamId/policy/preview", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-preview:${request.ip}`, 120, 60);
    const { teamId } = teamParams(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        managedCatalog: z.array(CatalogItemSchema).max(500),
        personalInstallations: PersonalInstallationsSchema,
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return teams.previewTeamPolicy(
      request.headers,
      teamId,
      body.expectedRevision,
      body.personalInstallations,
      body.managedCatalog,
    );
  });

  app.patch("/v1/teams/:teamId/policy", async (request, reply) => {
    await assertMutation(request, identity, config);
    const { teamId } = teamParams(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        managedCatalog: z.array(CatalogItemSchema).max(500),
        personalInstallations: PersonalInstallationsSchema,
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return teams.updateTeamPolicy(
      request.headers,
      teamId,
      body.expectedRevision,
      body.personalInstallations,
      body.managedCatalog,
    );
  });

  app.get(
    "/v1/teams/:teamId/members/:memberId/policy",
    async (request, reply) => {
      const { teamId, memberId } = z
        .object({
          memberId: MemberIdentifierSchema,
          teamId: TeamIdentifierSchema,
        })
        .strict()
        .parse(request.params);
      reply.header("cache-control", "private, no-store");
      return teams.getTeamMemberPolicy(request.headers, teamId, memberId);
    },
  );

  app.patch(
    "/v1/teams/:teamId/members/:memberId/policy",
    async (request, reply) => {
      await assertMutation(request, identity, config);
      const { teamId, memberId } = z
        .object({
          memberId: MemberIdentifierSchema,
          teamId: TeamIdentifierSchema,
        })
        .strict()
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
      return teams.updateTeamMemberPolicy(
        request.headers,
        teamId,
        memberId,
        body.expectedRevision,
        body.overrides,
      );
    },
  );

  app.delete(
    "/v1/teams/:teamId/members/:memberId/policy",
    async (request, reply) => {
      await assertMutation(request, identity, config);
      const { teamId, memberId } = z
        .object({
          memberId: MemberIdentifierSchema,
          teamId: TeamIdentifierSchema,
        })
        .strict()
        .parse(request.params);
      const query = z
        .object({ expectedRevision: z.coerce.number().int().positive() })
        .strict()
        .parse(request.query);
      reply.header("cache-control", "no-store");
      return teams.resetTeamMemberPolicy(
        request.headers,
        teamId,
        memberId,
        query.expectedRevision,
      );
    },
  );
}
