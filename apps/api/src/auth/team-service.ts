import { randomUUID } from "node:crypto";
import type {
  EligibleTeamMembersResponse,
  BulkTeamMembersResponse,
  ManagedCatalogItem,
  MemberPolicyOverrides,
  Person,
  PersonalInstallationPolicy,
  Role,
  Team,
  TeamMember,
  TeamMemberPolicy,
  TeamMembersResponse,
  TeamPolicy,
  TeamPolicyPreview,
  TeamRole,
  TeamsResponse,
} from "@lori-enterprise/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { recordAuditEvent } from "./audit.js";
import type { LoriAuth } from "./auth.js";
import {
  type EnrollmentService,
  memberPolicyOverridesChanged,
  organizationAssignments,
  resolveMemberPolicy,
  validateCatalog,
} from "./enrollment-service.js";
import { IdentityError } from "./identity-service.js";
import {
  activeOrganizationSql,
  isOrganizationAdministrator,
  parseOrganizationRole,
} from "./authority.js";
import {
  approveCodeExcess,
  delegationExcess,
  delegationRefused,
  loadCodeDelegation,
  storedDocument,
} from "./delegation.js";

const MAX_TEAMS = 500;
const MAX_TEAM_MEMBERS = 2_500;

interface BrowserSession {
  session?: { activeOrganizationId?: string | null };
  user: {
    id: string;
  };
}

interface ActorRow {
  member_id: string;
  organization_id: string;
  role: Role;
  user_id: string;
}

interface TeamRow {
  created_at: Date;
  description: string | null;
  id: string;
  member_count: string;
  name: string;
  organization_id: string;
  slug: string;
  updated_at: Date;
}

interface TeamMemberRow {
  email: string;
  joined_at: Date;
  member_id: string;
  name: string;
  role: TeamRole;
  team_member_id: string;
  team_admin_count?: string;
  total_count?: string;
}

export interface TeamListOptions {
  limit: number;
  offset: number;
  query: string;
}

interface TeamPolicyRow {
  allow_personal_plugins: boolean;
  allow_personal_providers: boolean;
  allow_personal_skills: boolean;
  organization_allow_personal_plugins: boolean;
  organization_allow_personal_providers: boolean;
  organization_allow_personal_skills: boolean;
  revision: string;
  updated_at: Date;
  updated_by_name: string | null;
}

interface CatalogPolicyRow {
  enabled: boolean;
  item_id: string;
  item_type: ManagedCatalogItem["type"];
}

interface PolicyOverrideRow {
  allow_personal_plugins: boolean | null;
  allow_personal_providers: boolean | null;
  allow_personal_skills: boolean | null;
}

export interface CreateTeamInput {
  description?: string | null;
  name: string;
  slug: string;
}

export interface UpdateTeamInput {
  description?: string | null;
  name?: string;
}

const requireRole: (value: string) => Role = parseOrganizationRole;

function requireTeamRole(value: string): TeamRole {
  if (value === "team_admin" || value === "member") {
    return value;
  }
  throw new IdentityError(400, "invalid_team_role", "The team role is invalid.");
}

export function assertTeamRoleMutationAllowed(
  actorRole: Role,
  currentRole: TeamRole,
  nextRole: TeamRole | "remove",
): void {
  if (
    !isOrganizationAdministrator(actorRole) &&
    (currentRole === "team_admin" || nextRole === "team_admin")
  ) {
    throw new IdentityError(
      403,
      "organization_admin_required_for_team_admin",
      "An organization administrator is required to grant or revoke team administrator access.",
    );
  }
}

function teamContract(row: TeamRow): Team {
  return {
    createdAt: row.created_at.toISOString(),
    ...(row.description ? { description: row.description } : {}),
    id: row.id,
    memberCount: Number(row.member_count),
    name: row.name,
    slug: row.slug,
    updatedAt: row.updated_at.toISOString(),
  };
}

function teamMemberContract(row: TeamMemberRow): TeamMember {
  return {
    email: row.email,
    joinedAt: row.joined_at.toISOString(),
    memberId: row.member_id,
    name: row.name,
    role: requireTeamRole(row.role),
    teamMemberId: row.team_member_id,
  };
}

function catalogContract(rows: CatalogPolicyRow[]): ManagedCatalogItem[] {
  return rows
    .map((row) => ({
      enabled: row.enabled,
      id: row.item_id,
      type: row.item_type,
    }))
    .sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    );
}

function teamPolicyContract(
  row: TeamPolicyRow,
  managedCatalog: ManagedCatalogItem[],
): TeamPolicy {
  return {
    managedCatalog,
    organizationPersonalInstallations: {
      plugins: row.organization_allow_personal_plugins,
      providers: row.organization_allow_personal_providers,
      skills: row.organization_allow_personal_skills,
    },
    personalInstallations: {
      plugins: row.allow_personal_plugins,
      providers: row.allow_personal_providers,
      skills: row.allow_personal_skills,
    },
    revision: Number(row.revision),
    updatedAt: row.updated_at.toISOString(),
    ...(row.updated_by_name ? { updatedByName: row.updated_by_name } : {}),
  };
}

function normalizeDescription(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function buildTeamPolicyPreview(
  current: TeamPolicy,
  personalInstallations: PersonalInstallationPolicy,
  managedCatalog: ManagedCatalogItem[],
  memberCount: number,
): TeamPolicyPreview {
  const currentCatalog = new Set(
    current.managedCatalog
      .filter((item) => item.enabled)
      .map((item) => `${item.type}:${item.id}`),
  );
  const nextCatalog = new Set(
    managedCatalog
      .filter((item) => item.enabled)
      .map((item) => `${item.type}:${item.id}`),
  );
  const personalKeys = ["plugins", "providers", "skills"] as const;
  return {
    catalogGrantsAdded: [...nextCatalog].filter(
      (identity) => !currentCatalog.has(identity),
    ).length,
    catalogGrantsRemoved: [...currentCatalog].filter(
      (identity) => !nextCatalog.has(identity),
    ).length,
    personalGrantsAdded: personalKeys.filter(
      (key) =>
        personalInstallations[key] && !current.personalInstallations[key],
    ).length,
    personalGrantsRemoved: personalKeys.filter(
      (key) =>
        !personalInstallations[key] && current.personalInstallations[key],
    ).length,
    potentiallyAffectedMemberCount: memberCount,
    revision: current.revision,
  };
}

export class TeamService {
  public constructor(
    private readonly pool: Pool,
    private readonly auth: LoriAuth,
    _config: AppConfig,
    private readonly enrollment?: EnrollmentService,
  ) {}

  private async actor(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<ActorRow> {
    const session = (await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    })) as BrowserSession | null;
    if (!session) {
      throw new IdentityError(401, "unauthenticated", "Sign in is required.");
    }
    const result = await database.query<ActorRow>(
      `
        SELECT
          members.id AS member_id,
          members."organizationId" AS organization_id,
          members.role,
          members."userId" AS user_id
        FROM member members
        WHERE members."userId" = $1
          AND members."organizationId" = ${activeOrganizationSql("$1", "$2")}
        LIMIT 1
      `,
      [session.user.id, session.session?.activeOrganizationId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        403,
        "membership_required",
        "This account does not belong to the organization.",
      );
    }
    return { ...row, role: requireRole(row.role) };
  }

  private async organizationAdmin(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<ActorRow> {
    const actor = await this.actor(headers, database);
    if (!isOrganizationAdministrator(actor.role)) {
      throw new IdentityError(
        403,
        "admin_required",
        "Organization administrator access is required.",
      );
    }
    return actor;
  }

  private async teamRow(
    organizationId: string,
    identifier: string,
    database: Pool | PoolClient,
  ): Promise<TeamRow> {
    const result = await database.query<TeamRow>(
      `
        SELECT
          teams.id,
          teams.organization_id,
          teams.name,
          teams.slug,
          teams.description,
          teams.created_at,
          teams.updated_at,
          COUNT(members.id)::text AS member_count
        FROM team teams
        LEFT JOIN team_member members ON members.team_id = teams.id
        WHERE teams.organization_id = $1
          AND (teams.id = $2 OR teams.slug = $2)
        GROUP BY teams.id
        ORDER BY CASE WHEN teams.id = $2 THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [organizationId, identifier],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(404, "team_not_found", "Team not found.");
    }
    return row;
  }

  public async assertTeamAdmin(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    database: Pool | PoolClient = this.pool,
  ): Promise<{ actor: ActorRow; team: TeamRow }> {
    const actor = await this.actor(headers, database);
    const team = await this.teamRow(
      actor.organization_id,
      teamIdentifier,
      database,
    );
    if (isOrganizationAdministrator(actor.role)) {
      return { actor, team };
    }
    await this.ensureTeamAdmin(actor, team.id, database);
    return { actor, team };
  }

  private async ensureTeamAdmin(
    actor: ActorRow,
    teamId: string,
    database: Pool | PoolClient,
  ): Promise<void> {
    if (isOrganizationAdministrator(actor.role)) return;
    const result = await database.query(
      `
        SELECT 1
        FROM team_member
        WHERE team_id = $1
          AND member_id = $2
          AND role = 'team_admin'
        LIMIT 1
      `,
      [teamId, actor.member_id],
    );
    if (!result.rowCount) {
      throw new IdentityError(
        403,
        "team_admin_required",
        "Team administrator access is required.",
      );
    }
  }

  private async revalidateTeamAdmin(
    headers: IncomingHttpHeaders,
    actor: ActorRow,
    teamId: string,
    database: PoolClient,
  ): Promise<void> {
    const current = await this.actor(headers, database);
    if (
      current.user_id !== actor.user_id ||
      current.organization_id !== actor.organization_id
    ) {
      throw new IdentityError(
        403,
        "membership_required",
        "This account does not belong to the organization.",
      );
    }
    Object.assign(actor, current);
    await this.ensureTeamAdmin(actor, teamId, database);
  }

  private async revalidateOrganizationAdmin(
    headers: IncomingHttpHeaders,
    actor: ActorRow,
    database: PoolClient,
  ): Promise<void> {
    const current = await this.organizationAdmin(headers, database);
    if (
      current.user_id !== actor.user_id ||
      current.organization_id !== actor.organization_id
    ) {
      throw new IdentityError(
        403,
        "admin_required",
        "Organization administrator access is required.",
      );
    }
    Object.assign(actor, current);
  }

  private async lockOrganizationRevision(
    database: PoolClient,
    organizationId: string,
    expectedRevision?: number,
  ): Promise<number> {
    const result = await database.query<{ revision: string }>(
      `
        SELECT revision::text
        FROM organization_policies
        WHERE organization_id = $1
        FOR UPDATE
      `,
      [organizationId],
    );
    const revision = Number(result.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new IdentityError(
        503,
        "policy_unavailable",
        "Organization policy is unavailable.",
      );
    }
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new IdentityError(
        409,
        "policy_revision_conflict",
        "Organization policy changed. Reload before saving again.",
      );
    }
    return revision;
  }

  private async bumpOrganizationRevision(
    database: PoolClient,
    organizationId: string,
    actorUserId: string,
  ): Promise<void> {
    await database.query(
      `
        UPDATE organization_policies
        SET
          revision = revision + 1,
          updated_at = NOW(),
          updated_by_user_id = $2
        WHERE organization_id = $1
      `,
      [organizationId, actorUserId],
    );
  }

  public async listTeams(
    headers: IncomingHttpHeaders,
  ): Promise<TeamsResponse> {
    const actor = await this.actor(headers);
    const result = await this.pool.query<TeamRow>(
      `
        SELECT
          teams.id,
          teams.organization_id,
          teams.name,
          teams.slug,
          teams.description,
          teams.created_at,
          teams.updated_at,
          COUNT(all_members.id)::text AS member_count
        FROM team teams
        LEFT JOIN team_member all_members ON all_members.team_id = teams.id
        WHERE teams.organization_id = $1
          AND (
            $2::boolean
            OR EXISTS (
              SELECT 1
              FROM team_member managed_membership
              WHERE managed_membership.team_id = teams.id
                AND managed_membership.member_id = $3
                AND managed_membership.role = 'team_admin'
            )
          )
        GROUP BY teams.id
        ORDER BY lower(teams.name), teams.slug
      `,
      [
        actor.organization_id,
        isOrganizationAdministrator(actor.role),
        actor.member_id,
      ],
    );
    if (!isOrganizationAdministrator(actor.role) && result.rows.length === 0) {
      throw new IdentityError(
        403,
        "team_admin_required",
        "Team administrator access is required.",
      );
    }
    return { teams: result.rows.map(teamContract) };
  }

  public async getTeam(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
  ): Promise<Team> {
    const { team } = await this.assertTeamAdmin(headers, teamIdentifier);
    return teamContract(team);
  }

  public async createTeam(
    headers: IncomingHttpHeaders,
    input: CreateTeamInput,
  ): Promise<Team> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.organizationAdmin(headers, client);
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateOrganizationAdmin(headers, actor, client);
      const personal = await client.query(
        "SELECT 1 FROM organization WHERE id = $1 AND personal_user_id IS NOT NULL",
        [actor.organization_id],
      );
      if (personal.rowCount) {
        throw new IdentityError(
          409,
          "personal_workspace",
          "A personal workspace is just for you. Create an organization to use teams.",
        );
      }
      const count = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM team WHERE organization_id = $1",
        [actor.organization_id],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TEAMS) {
        throw new IdentityError(
          409,
          "team_limit",
          "This organization has reached its team limit.",
        );
      }
      const duplicate = await client.query(
        "SELECT 1 FROM team WHERE organization_id = $1 AND slug = $2 LIMIT 1",
        [actor.organization_id, input.slug],
      );
      if (duplicate.rowCount) {
        throw new IdentityError(
          409,
          "team_slug_exists",
          "A team already uses this URL slug.",
        );
      }
      const teamId = randomUUID();
      await client.query(
        `
          INSERT INTO team (
            id,
            organization_id,
            name,
            slug,
            description,
            created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          teamId,
          actor.organization_id,
          input.name.trim(),
          input.slug,
          normalizeDescription(input.description),
          actor.user_id,
        ],
      );
      await client.query(
        "INSERT INTO team_policies (team_id) VALUES ($1)",
        [teamId],
      );
      await this.bumpOrganizationRevision(
        client,
        actor.organization_id,
        actor.user_id,
      );
      await recordAuditEvent(client, {
        action: "team.created",
        actorUserId: actor.user_id,
        organizationId: actor.organization_id,
        metadata: { name: input.name.trim(), slug: input.slug },
        subjectId: teamId,
        subjectType: "team",
      });
      const created = await this.teamRow(
        actor.organization_id,
        teamId,
        client,
      );
      await client.query("COMMIT");
      return teamContract(created);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateTeam(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    input: UpdateTeamInput,
  ): Promise<Team> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const name = input.name?.trim() ?? team.name;
      const description =
        input.description === undefined
          ? team.description
          : normalizeDescription(input.description);
      const changed = name !== team.name || description !== team.description;
      if (changed) {
        await client.query(
          `
            UPDATE team
            SET name = $2, description = $3, updated_at = NOW()
            WHERE id = $1
          `,
          [team.id, name, description],
        );
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.updated",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: { name, previousName: team.name },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const updated = await this.teamRow(
        actor.organization_id,
        team.id,
        client,
      );
      await client.query("COMMIT");
      return teamContract(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteTeam(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.organizationAdmin(headers, client);
      const team = await this.teamRow(
        actor.organization_id,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateOrganizationAdmin(headers, actor, client);
      await client.query("DELETE FROM team WHERE id = $1", [team.id]);
      await this.bumpOrganizationRevision(
        client,
        actor.organization_id,
        actor.user_id,
      );
      await recordAuditEvent(client, {
        action: "team.deleted",
        actorUserId: actor.user_id,
        organizationId: actor.organization_id,
        metadata: { name: team.name, slug: team.slug },
        subjectId: team.id,
        subjectType: "team",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async teamMemberRow(
    teamId: string,
    memberId: string,
    database: Pool | PoolClient,
    byTeamMemberId = false,
  ): Promise<TeamMemberRow> {
    const result = await database.query<TeamMemberRow>(
      `
        SELECT
          memberships.id AS team_member_id,
          memberships.member_id,
          memberships.role,
          memberships.joined_at,
          users.name,
          users.email
        FROM team_member memberships
        JOIN member members ON members.id = memberships.member_id
        JOIN "user" users ON users.id = members."userId"
        WHERE memberships.team_id = $1
          AND ${byTeamMemberId ? "memberships.id" : "memberships.member_id"} = $2
        LIMIT 1
      `,
      [teamId, memberId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        404,
        "team_member_not_found",
        "Team member not found.",
      );
    }
    return row;
  }

  public async listTeamMembers(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    options: TeamListOptions = { limit: 50, offset: 0, query: "" },
  ): Promise<TeamMembersResponse> {
    const { team } = await this.assertTeamAdmin(headers, teamIdentifier);
    const result = await this.pool.query<TeamMemberRow>(
      `
        SELECT
          memberships.id AS team_member_id,
          memberships.member_id,
          memberships.role,
          memberships.joined_at,
          users.name,
          users.email,
          COUNT(*) OVER()::text AS total_count,
          (
            SELECT COUNT(*)::text
            FROM team_member team_admins
            WHERE team_admins.team_id = memberships.team_id
              AND team_admins.role = 'team_admin'
          ) AS team_admin_count
        FROM team_member memberships
        JOIN member members ON members.id = memberships.member_id
        JOIN "user" users ON users.id = members."userId"
        WHERE memberships.team_id = $1
          AND (
            $2 = ''
            OR users.name ILIKE '%' || $2 || '%'
            OR users.email ILIKE '%' || $2 || '%'
          )
        ORDER BY lower(users.name), users.email
        LIMIT $3 OFFSET $4
      `,
      [team.id, options.query, options.limit, options.offset],
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      members: result.rows.map(teamMemberContract),
      pageInfo: {
        hasMore: options.offset + result.rows.length < total,
        limit: options.limit,
        offset: options.offset,
        total,
      },
      teamAdminCount: Number(result.rows[0]?.team_admin_count ?? 0),
    };
  }

  public async listEligibleTeamMembers(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    options: TeamListOptions = { limit: 50, offset: 0, query: "" },
  ): Promise<EligibleTeamMembersResponse> {
    const { actor, team } = await this.assertTeamAdmin(
      headers,
      teamIdentifier,
    );
    const result = await this.pool.query<{
      created_at: Date;
      email: string;
      member_id: string;
      name: string;
      role: Role;
      user_id: string;
      total_count: string;
    }>(
      `
        SELECT
          members.id AS member_id,
          members."userId" AS user_id,
          members.role,
          members."createdAt" AS created_at,
          users.name,
          users.email
          ,COUNT(*) OVER()::text AS total_count
        FROM member members
        JOIN "user" users ON users.id = members."userId"
        WHERE members."organizationId" = $1
          AND NOT EXISTS (
            SELECT 1
            FROM team_member memberships
            WHERE memberships.team_id = $2
              AND memberships.member_id = members.id
          )
          AND (
            $3 = ''
            OR users.name ILIKE '%' || $3 || '%'
            OR users.email ILIKE '%' || $3 || '%'
          )
        ORDER BY lower(users.name), users.email
        LIMIT $4 OFFSET $5
      `,
      [
        actor.organization_id,
        team.id,
        options.query,
        options.limit,
        options.offset,
      ],
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      members: result.rows.map((row) => ({
        createdAt: row.created_at.toISOString(),
        email: row.email,
        memberId: row.member_id,
        name: row.name,
        role: requireRole(row.role),
        userId: row.user_id,
      })),
      pageInfo: {
        hasMore: options.offset + result.rows.length < total,
        limit: options.limit,
        offset: options.offset,
        total,
      },
    };
  }

  public async addTeamMembers(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    requestedMemberIds: string[],
    requestedRole: TeamRole,
  ): Promise<BulkTeamMembersResponse> {
    const memberIds = [...new Set(requestedMemberIds)];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const role = requireTeamRole(requestedRole);
      assertTeamRoleMutationAllowed(actor.role, "member", role);
      const targets = await client.query<{ id: string }>(
        `
          SELECT id
          FROM member
          WHERE "organizationId" = $1 AND id = ANY($2::text[])
        `,
        [actor.organization_id, memberIds],
      );
      if (targets.rows.length !== memberIds.length) {
        throw new IdentityError(
          404,
          "member_not_found",
          "One or more organization members could not be found.",
        );
      }
      const existing = await client.query<{ member_id: string }>(
        `
          SELECT member_id
          FROM team_member
          WHERE team_id = $1 AND member_id = ANY($2::text[])
        `,
        [team.id, memberIds],
      );
      const existingIds = new Set(existing.rows.map((row) => row.member_id));
      const toAdd = memberIds.filter((memberId) => !existingIds.has(memberId));
      const count = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM team_member WHERE team_id = $1",
        [team.id],
      );
      if (Number(count.rows[0]?.count ?? 0) + toAdd.length > MAX_TEAM_MEMBERS) {
        throw new IdentityError(
          409,
          "team_member_limit",
          "Adding these people would exceed the team member limit.",
        );
      }
      for (const memberId of toAdd) {
        await client.query(
          `
            INSERT INTO team_member (id, team_id, member_id, role)
            VALUES ($1, $2, $3, $4)
          `,
          [randomUUID(), team.id, memberId, role],
        );
      }
      if (toAdd.length > 0) {
        await client.query("UPDATE team SET updated_at = NOW() WHERE id = $1", [
          team.id,
        ]);
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.members_added",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: { memberIds: toAdd, role },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const added = await Promise.all(
        toAdd.map(async (memberId) =>
          teamMemberContract(
            await this.teamMemberRow(team.id, memberId, client),
          ),
        ),
      );
      await client.query("COMMIT");
      return {
        added,
        skippedMemberIds: memberIds.filter((memberId) => existingIds.has(memberId)),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async addTeamMember(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    memberId: string,
    requestedRole: TeamRole,
  ): Promise<TeamMember> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const target = await client.query(
        `
          SELECT 1
          FROM member
          WHERE id = $1 AND "organizationId" = $2
          LIMIT 1
        `,
        [memberId, actor.organization_id],
      );
      if (!target.rowCount) {
        throw new IdentityError(404, "member_not_found", "Member not found.");
      }
      const duplicate = await client.query(
        "SELECT 1 FROM team_member WHERE team_id = $1 AND member_id = $2 LIMIT 1",
        [team.id, memberId],
      );
      if (duplicate.rowCount) {
        throw new IdentityError(
          409,
          "already_team_member",
          "This person is already on the team.",
        );
      }
      const count = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM team_member WHERE team_id = $1",
        [team.id],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TEAM_MEMBERS) {
        throw new IdentityError(
          409,
          "team_member_limit",
          "This team has reached its member limit.",
        );
      }
      const teamMemberId = randomUUID();
      const role = requireTeamRole(requestedRole);
      assertTeamRoleMutationAllowed(actor.role, "member", role);
      await client.query(
        `
          INSERT INTO team_member (id, team_id, member_id, role)
          VALUES ($1, $2, $3, $4)
        `,
        [teamMemberId, team.id, memberId, role],
      );
      await client.query("UPDATE team SET updated_at = NOW() WHERE id = $1", [
        team.id,
      ]);
      await this.bumpOrganizationRevision(
        client,
        actor.organization_id,
        actor.user_id,
      );
      await recordAuditEvent(client, {
        action: "team.member_added",
        actorUserId: actor.user_id,
        organizationId: actor.organization_id,
        metadata: { memberId, role },
        subjectId: team.id,
        subjectType: "team",
      });
      const created = await this.teamMemberRow(
        team.id,
        teamMemberId,
        client,
        true,
      );
      await client.query("COMMIT");
      return teamMemberContract(created);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateTeamMemberRole(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    teamMemberId: string,
    requestedRole: TeamRole,
  ): Promise<TeamMember> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const current = await this.teamMemberRow(
        team.id,
        teamMemberId,
        client,
        true,
      );
      const role = requireTeamRole(requestedRole);
      assertTeamRoleMutationAllowed(actor.role, current.role, role);
      if (current.role !== role) {
        await client.query(
          "UPDATE team_member SET role = $2 WHERE id = $1",
          [teamMemberId, role],
        );
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.member_role_changed",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: {
            from: current.role,
            memberId: current.member_id,
            to: role,
          },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const updated = await this.teamMemberRow(
        team.id,
        teamMemberId,
        client,
        true,
      );
      await client.query("COMMIT");
      return teamMemberContract(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async removeTeamMember(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    teamMemberId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(client, actor.organization_id);
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const current = await this.teamMemberRow(
        team.id,
        teamMemberId,
        client,
        true,
      );
      assertTeamRoleMutationAllowed(actor.role, current.role, "remove");
      await client.query(
        "DELETE FROM team_member WHERE id = $1 AND team_id = $2",
        [teamMemberId, team.id],
      );
      await client.query("UPDATE team SET updated_at = NOW() WHERE id = $1", [
        team.id,
      ]);
      await this.bumpOrganizationRevision(
        client,
        actor.organization_id,
        actor.user_id,
      );
      await recordAuditEvent(client, {
        action: "team.member_removed",
        actorUserId: actor.user_id,
        organizationId: actor.organization_id,
        metadata: { memberId: current.member_id, role: current.role },
        subjectId: team.id,
        subjectType: "team",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Team grants stay inside the organization's delegation ceiling. A team
   * administrator is refused; an organization administrator's explicit grant
   * approves the item for team delegation (audited).
   */
  private async applyCodeDelegation(
    client: PoolClient,
    actor: ActorRow,
    teamId: string,
    previous: Parameters<typeof delegationExcess>[0]["previous"],
    next: Parameters<typeof delegationExcess>[0]["next"],
  ): Promise<void> {
    const { effective, stored } = await loadCodeDelegation(
      client,
      actor.organization_id,
    );
    const excess = delegationExcess({ ceiling: effective, next, previous });
    if (!excess) return;
    if (!isOrganizationAdministrator(actor.role)) throw delegationRefused(excess);
    const approved = approveCodeExcess(stored, excess);
    await client.query(
      "UPDATE organization_policies SET delegation = $2::jsonb WHERE organization_id = $1",
      [actor.organization_id, storedDocument(approved)],
    );
    await recordAuditEvent(client, {
      action: "organization.delegation_updated",
      actorUserId: actor.user_id,
      organizationId: actor.organization_id,
      metadata: { approvedForTeamId: teamId, before: stored, after: approved, product: "code" },
      subjectId: actor.organization_id,
      subjectType: "organization",
    });
  }

  private async policyForTeam(
    teamId: string,
    database: Pool | PoolClient,
  ): Promise<TeamPolicy> {
    const result = await database.query<TeamPolicyRow>(
      `
        SELECT
          organization_policies.revision::text,
          organization_policies.allow_personal_plugins
            AS organization_allow_personal_plugins,
          organization_policies.allow_personal_providers
            AS organization_allow_personal_providers,
          organization_policies.allow_personal_skills
            AS organization_allow_personal_skills,
          policies.allow_personal_plugins,
          policies.allow_personal_providers,
          policies.allow_personal_skills,
          policies.updated_at,
          users.name AS updated_by_name
        FROM team_policies policies
        JOIN team teams ON teams.id = policies.team_id
        JOIN organization_policies
          ON organization_policies.organization_id = teams.organization_id
        LEFT JOIN "user" users ON users.id = policies.updated_by_user_id
        WHERE policies.team_id = $1
      `,
      [teamId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        503,
        "team_policy_unavailable",
        "Team policy has not been initialized.",
      );
    }
    const catalog = await database.query<CatalogPolicyRow>(
      `
        SELECT item_type, item_id, enabled
        FROM team_catalog_policies
        WHERE team_id = $1 AND enabled = TRUE
      `,
      [teamId],
    );
    const organization = await database.query<{ organization_id: string }>(
      "SELECT organization_id FROM team WHERE id = $1",
      [teamId],
    );
    const delegation = organization.rows[0]
      ? (await loadCodeDelegation(database, organization.rows[0].organization_id))
          .effective
      : undefined;
    return {
      ...teamPolicyContract(row, catalogContract(catalog.rows)),
      ...(delegation ? { delegation } : {}),
    };
  }

  public async getTeamPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
  ): Promise<TeamPolicy> {
    const { team } = await this.assertTeamAdmin(headers, teamIdentifier);
    return this.policyForTeam(team.id, this.pool);
  }

  public async previewTeamPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    expectedRevision: number,
    personalInstallations: PersonalInstallationPolicy,
    managedCatalog: ManagedCatalogItem[],
  ): Promise<TeamPolicyPreview> {
    validateCatalog(managedCatalog);
    const { team } = await this.assertTeamAdmin(headers, teamIdentifier);
    const current = await this.policyForTeam(team.id, this.pool);
    if (current.revision !== expectedRevision) {
      throw new IdentityError(
        409,
        "policy_revision_conflict",
        "Organization policy changed. Reload before reviewing these changes.",
      );
    }
    return buildTeamPolicyPreview(
      current,
      personalInstallations,
      organizationAssignments(managedCatalog),
      Number(team.member_count),
    );
  }

  public async updateTeamPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    expectedRevision: number,
    personalInstallations: PersonalInstallationPolicy,
    managedCatalog: ManagedCatalogItem[],
  ): Promise<TeamPolicy> {
    validateCatalog(managedCatalog);
    const assignments = organizationAssignments(managedCatalog);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(
        client,
        actor.organization_id,
        expectedRevision,
      );
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const current = await client.query<TeamPolicyRow>(
        `
          SELECT
            $2::text AS revision,
            organization_policies.allow_personal_plugins
              AS organization_allow_personal_plugins,
            organization_policies.allow_personal_providers
              AS organization_allow_personal_providers,
            organization_policies.allow_personal_skills
              AS organization_allow_personal_skills,
            team_policies.allow_personal_plugins,
            team_policies.allow_personal_providers,
            team_policies.allow_personal_skills,
            team_policies.updated_at,
            NULL::text AS updated_by_name
          FROM team_policies
          JOIN team teams ON teams.id = team_policies.team_id
          JOIN organization_policies
            ON organization_policies.organization_id = teams.organization_id
          WHERE team_id = $1
          FOR UPDATE
        `,
        [team.id, String(expectedRevision)],
      );
      const currentRow = current.rows[0];
      if (!currentRow) {
        throw new IdentityError(
          503,
          "team_policy_unavailable",
          "Team policy is unavailable.",
        );
      }
      const currentCatalog = await client.query<CatalogPolicyRow>(
        `
          SELECT item_type, item_id, enabled
          FROM team_catalog_policies
          WHERE team_id = $1
        `,
        [team.id],
      );
      const changed =
        currentRow.allow_personal_plugins !== personalInstallations.plugins ||
        currentRow.allow_personal_providers !==
          personalInstallations.providers ||
        currentRow.allow_personal_skills !== personalInstallations.skills ||
        JSON.stringify(catalogContract(currentCatalog.rows)) !==
          JSON.stringify(assignments);
      if (changed) {
        await this.applyCodeDelegation(
          client,
          actor,
          team.id,
          {
            managedCatalog: catalogContract(currentCatalog.rows),
            personalInstallations: {
              plugins: currentRow.allow_personal_plugins,
              providers: currentRow.allow_personal_providers,
              skills: currentRow.allow_personal_skills,
            },
          },
          { managedCatalog: assignments, personalInstallations },
        );
        await client.query(
          `
            UPDATE team_policies
            SET
              revision = revision + 1,
              allow_personal_plugins = $2,
              allow_personal_providers = $3,
              allow_personal_skills = $4,
              updated_at = NOW(),
              updated_by_user_id = $5
            WHERE team_id = $1
          `,
          [
            team.id,
            personalInstallations.plugins,
            personalInstallations.providers,
            personalInstallations.skills,
            actor.user_id,
          ],
        );
        await client.query(
          "DELETE FROM team_catalog_policies WHERE team_id = $1",
          [team.id],
        );
        for (const item of assignments) {
          await client.query(
            `
              INSERT INTO team_catalog_policies (
                team_id,
                item_type,
                item_id,
                enabled,
                updated_by_user_id
              )
              VALUES ($1, $2, $3, TRUE, $4)
            `,
            [team.id, item.type, item.id, actor.user_id],
          );
        }
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.policy_updated",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: {
            managedCatalogItems: assignments.length,
            personalPlugins: personalInstallations.plugins,
            personalProviders: personalInstallations.providers,
            personalSkills: personalInstallations.skills,
            previousRevision: expectedRevision,
          },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const policy = await this.policyForTeam(team.id, client);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async personForTeamMember(
    teamId: string,
    memberId: string,
    database: Pool | PoolClient,
  ): Promise<{ person: Person; teamMember: TeamMemberRow }> {
    const teamMember = await this.teamMemberRow(teamId, memberId, database);
    const result = await database.query<{
      created_at: Date;
      role: Role;
      user_id: string;
    }>(
      `
        SELECT
          members."createdAt" AS created_at,
          members.role,
          members."userId" AS user_id
        FROM member members
        WHERE members.id = $1
      `,
      [memberId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(404, "member_not_found", "Member not found.");
    }
    return {
      person: {
        createdAt: row.created_at.toISOString(),
        email: teamMember.email,
        memberId,
        name: teamMember.name,
        role: requireRole(row.role),
        userId: row.user_id,
      },
      teamMember,
    };
  }

  private async teamMemberPolicy(
    teamId: string,
    memberId: string,
    database: Pool | PoolClient,
  ): Promise<TeamMemberPolicy> {
    const { person, teamMember } = await this.personForTeamMember(
      teamId,
      memberId,
      database,
    );
    const team = await this.policyForTeam(teamId, database);
    const personalResult = await database.query<PolicyOverrideRow>(
      `
          SELECT
            allow_personal_plugins,
            allow_personal_providers,
            allow_personal_skills
          FROM team_member_policy_overrides
          WHERE team_member_id = $1
        `,
      [teamMember.team_member_id],
    );
    const catalogResult = await database.query<CatalogPolicyRow>(
      `
          SELECT item_type, item_id, enabled
          FROM team_member_catalog_overrides
          WHERE team_member_id = $1
        `,
      [teamMember.team_member_id],
    );
    const personal = personalResult.rows[0];
    const overrides: MemberPolicyOverrides = {
      managedCatalog: catalogContract(catalogResult.rows),
      personalInstallations: {
        plugins: personal?.allow_personal_plugins ?? null,
        providers: personal?.allow_personal_providers ?? null,
        skills: personal?.allow_personal_skills ?? null,
      },
    };
    const teamContribution: TeamPolicy = {
        ...resolveMemberPolicy(
          team,
          overrides.personalInstallations,
          overrides.managedCatalog,
        ),
        organizationPersonalInstallations:
          team.organizationPersonalInstallations,
      };
    const organizationResult = await database.query<{
      organization_id: string;
    }>("SELECT organization_id FROM team WHERE id = $1", [teamId]);
    const organizationId = organizationResult.rows[0]?.organization_id;
    const finalEffective =
      this.enrollment && organizationId
        ? await this.enrollment.effectivePolicyForMember(
            organizationId,
            memberId,
            database,
          )
        : teamContribution;
    return {
      effective: teamContribution,
      finalEffective,
      member: person,
      overrides,
      team,
      teamContribution,
    };
  }

  public async getTeamMemberPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    memberId: string,
  ): Promise<TeamMemberPolicy> {
    const { team } = await this.assertTeamAdmin(headers, teamIdentifier);
    return this.teamMemberPolicy(team.id, memberId, this.pool);
  }

  public async updateTeamMemberPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    memberId: string,
    expectedRevision: number,
    overrides: MemberPolicyOverrides,
  ): Promise<TeamMemberPolicy> {
    validateCatalog(overrides.managedCatalog);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(
        client,
        actor.organization_id,
        expectedRevision,
      );
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const { teamMember } = await this.personForTeamMember(
        team.id,
        memberId,
        client,
      );
      const personalResult = await client.query<PolicyOverrideRow>(
        `
            SELECT
              allow_personal_plugins,
              allow_personal_providers,
              allow_personal_skills
            FROM team_member_policy_overrides
            WHERE team_member_id = $1
          `,
        [teamMember.team_member_id],
      );
      const catalogResult = await client.query<CatalogPolicyRow>(
        `
            SELECT item_type, item_id, enabled
            FROM team_member_catalog_overrides
            WHERE team_member_id = $1
          `,
        [teamMember.team_member_id],
      );
      const personal = personalResult.rows[0];
      const nextCatalog = [...overrides.managedCatalog].sort((left, right) =>
        `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
      );
      const changed = memberPolicyOverridesChanged(
        {
          managedCatalog: catalogContract(catalogResult.rows),
          personalInstallations: {
            plugins: personal?.allow_personal_plugins ?? null,
            providers: personal?.allow_personal_providers ?? null,
            skills: personal?.allow_personal_skills ?? null,
          },
        },
        { ...overrides, managedCatalog: nextCatalog },
      );
      if (changed) {
        const teamPolicy = await this.policyForTeam(team.id, client);
        const previousCatalog = new Map(
          teamPolicy.managedCatalog.map((item) => [`${item.type}:${item.id}`, item]),
        );
        for (const item of catalogContract(catalogResult.rows))
          previousCatalog.set(`${item.type}:${item.id}`, item);
        await this.applyCodeDelegation(
          client,
          actor,
          team.id,
          {
            managedCatalog: [...previousCatalog.values()],
            personalInstallations: {
              plugins:
                personal?.allow_personal_plugins ??
                teamPolicy.personalInstallations.plugins,
              providers:
                personal?.allow_personal_providers ??
                teamPolicy.personalInstallations.providers,
              skills:
                personal?.allow_personal_skills ??
                teamPolicy.personalInstallations.skills,
            },
          },
          {
            managedCatalog: nextCatalog,
            personalInstallations: overrides.personalInstallations,
          },
        );
        const hasPersonal = Object.values(
          overrides.personalInstallations,
        ).some((value) => value !== null);
        if (hasPersonal) {
          await client.query(
            `
              INSERT INTO team_member_policy_overrides (
                team_member_id,
                allow_personal_plugins,
                allow_personal_providers,
                allow_personal_skills,
                updated_by_user_id
              )
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (team_member_id) DO UPDATE SET
                allow_personal_plugins = EXCLUDED.allow_personal_plugins,
                allow_personal_providers = EXCLUDED.allow_personal_providers,
                allow_personal_skills = EXCLUDED.allow_personal_skills,
                updated_at = NOW(),
                updated_by_user_id = EXCLUDED.updated_by_user_id
            `,
            [
              teamMember.team_member_id,
              overrides.personalInstallations.plugins,
              overrides.personalInstallations.providers,
              overrides.personalInstallations.skills,
              actor.user_id,
            ],
          );
        } else {
          await client.query(
            "DELETE FROM team_member_policy_overrides WHERE team_member_id = $1",
            [teamMember.team_member_id],
          );
        }
        await client.query(
          "DELETE FROM team_member_catalog_overrides WHERE team_member_id = $1",
          [teamMember.team_member_id],
        );
        for (const item of nextCatalog) {
          await client.query(
            `
              INSERT INTO team_member_catalog_overrides (
                team_member_id,
                item_type,
                item_id,
                enabled,
                updated_by_user_id
              )
              VALUES ($1, $2, $3, $4, $5)
            `,
            [
              teamMember.team_member_id,
              item.type,
              item.id,
              item.enabled,
              actor.user_id,
            ],
          );
        }
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.member_policy_updated",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: {
            catalogOverrides: nextCatalog.length,
            memberId,
            previousRevision: expectedRevision,
          },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const policy = await this.teamMemberPolicy(team.id, memberId, client);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async resetTeamMemberPolicy(
    headers: IncomingHttpHeaders,
    teamIdentifier: string,
    memberId: string,
    expectedRevision: number,
  ): Promise<TeamMemberPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, team } = await this.assertTeamAdmin(
        headers,
        teamIdentifier,
        client,
      );
      await this.lockOrganizationRevision(
        client,
        actor.organization_id,
        expectedRevision,
      );
      await this.revalidateTeamAdmin(headers, actor, team.id, client);
      const { teamMember } = await this.personForTeamMember(
        team.id,
        memberId,
        client,
      );
      const personal = await client.query(
        `
          DELETE FROM team_member_policy_overrides
          WHERE team_member_id = $1
          RETURNING team_member_id
        `,
        [teamMember.team_member_id],
      );
      const catalog = await client.query(
        `
          DELETE FROM team_member_catalog_overrides
          WHERE team_member_id = $1
          RETURNING team_member_id
        `,
        [teamMember.team_member_id],
      );
      if (personal.rowCount || catalog.rowCount) {
        await this.bumpOrganizationRevision(
          client,
          actor.organization_id,
          actor.user_id,
        );
        await recordAuditEvent(client, {
          action: "team.member_policy_reset",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          metadata: { memberId, previousRevision: expectedRevision },
          subjectId: team.id,
          subjectType: "team",
        });
      }
      const policy = await this.teamMemberPolicy(team.id, memberId, client);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
