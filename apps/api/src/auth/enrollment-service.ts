import { randomUUID } from "node:crypto";
import type {
  CodeDelegationPolicy,
  EffectiveCodeDelegation,
  DesktopBootstrap,
  DesktopInventoryItem,
  DesktopInventoryReport,
  Device,
  DevicesResponse,
  DesktopPlatform,
  EnrollmentAuthorization,
  EnrollmentTokenResponse,
  ManagedCatalogItem,
  ManagedCatalogItemAttribution,
  MemberPolicy,
  MemberPolicyOverrides,
  OrganizationPolicy,
  Person,
  PersonalInstallationAttribution,
  PersonalInstallationPolicy,
  PolicyCatalog,
  PolicySourceTeam,
  Role,
  TeamSummary,
} from "@lori-enterprise/contracts";
import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { assertCatalogItem, policyCatalog } from "../catalog.js";
import { recordAuditEvent } from "./audit.js";
import type { LoriAuth } from "./auth.js";
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  desktopPolicyEtag,
  ENROLLMENT_CODE_LIFETIME_SECONDS,
  generateDesktopToken,
  hashDesktopToken,
  readBearerToken,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  verifyPkce,
} from "./desktop-tokens.js";
import { IdentityError } from "./identity-service.js";
import {
  activeOrganizationSql,
  isOrganizationAdministrator,
  legacyOrganizationRole,
  organizationCapabilities,
  parseOrganizationRole,
} from "./authority.js";
import {
  CodeDelegationSchema,
  catalogApproved,
  effectiveCodeDelegation,
  normalizeCodeDelegation,
  storedCodeDelegation,
  storedDocument,
} from "./delegation.js";

interface BrowserSession {
  session?: { activeOrganizationId?: string | null };
  user: {
    id: string;
  };
}

interface MemberRow {
  email: string;
  member_id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  role: Role;
  user_id: string;
}

interface PolicyRow {
  allow_personal_plugins: boolean;
  allow_personal_providers: boolean;
  allow_personal_skills: boolean;
  revision: string;
  updated_at: Date;
  updated_by_name: string | null;
}

interface CatalogPolicyRow {
  enabled: boolean;
  item_id: string;
  item_type: ManagedCatalogItem["type"];
}

interface MemberPolicyOverrideRow {
  allow_personal_plugins: boolean | null;
  allow_personal_providers: boolean | null;
  allow_personal_skills: boolean | null;
}

interface TeamPersonalContributionRow {
  plugins: boolean;
  providers: boolean;
  skills: boolean;
}

interface TeamPersonalContributionDetailRow extends TeamPersonalContributionRow {
  team_id: string;
  team_name: string;
  team_slug: string;
}

interface TeamCatalogContributionRow extends CatalogPolicyRow {
  team_id: string;
  team_name: string;
  team_slug: string;
}

export interface TeamCatalogContribution extends ManagedCatalogItem {
  team: PolicySourceTeam;
}

export interface DesktopUpdateState {
  deviceId: string;
  organizationId: string;
  revision: number;
}

interface AuthorizationCodeRow {
  app_version: string;
  code_challenge: string;
  consumed_at: Date | null;
  device_id: string;
  device_name: string;
  expires_at: Date;
  id: string;
  organization_id: string;
  platform: DesktopPlatform;
  user_id: string;
}

interface RefreshRow {
  consumed_at: Date | null;
  device_id: string;
  device_revoked_at: Date | null;
  expires_at: Date;
  organization_id: string;
  refresh_id: string;
  session_id: string;
  session_revoked_at: Date | null;
  token_family_id: string;
  user_id: string;
}

interface AccessRow extends MemberRow {
  access_expires_at: Date;
  app_version: string;
  device_id: string;
  device_name: string;
  device_revoked_at: Date | null;
  platform: DesktopPlatform;
  session_id: string;
  session_revoked_at: Date | null;
}

/**
 * Device identity verified from the short-lived desktop access token. This is
 * deliberately a minimal, non-secret view for additive desktop services such
 * as the organization provider gateway.
 */
export interface DesktopAccess {
  sessionId: string;
  deviceId: string;
  memberId: string;
  organizationId: string;
  userId: string;
}

export interface AuthorizeEnrollmentInput {
  appVersion: string;
  callbackUrl?: string;
  codeChallenge: string;
  deviceName: string;
  /** The organization the approval page showed; it must still be the active one. */
  expectedOrganizationId?: string;
  platform: DesktopPlatform;
  state?: string;
}

export interface ExchangeEnrollmentInput {
  code: string;
  codeVerifier: string;
}

const role: (value: string) => Role = parseOrganizationRole;

function policyContract(
  row: PolicyRow,
  managedCatalog: ManagedCatalogItem[],
): OrganizationPolicy {
  return {
    managedCatalog,
    personalInstallationAttribution: {
      plugins: { source: "organization" },
      providers: { source: "organization" },
      skills: { source: "organization" },
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

const personalInstallationKeys = ["plugins", "providers", "skills"] as const;

function personalInstallationAttribution(
  organization: PersonalInstallationPolicy,
  teams: TeamPersonalContributionDetailRow[],
  memberOverride:
    | {
        plugins: boolean | null;
        providers: boolean | null;
        skills: boolean | null;
      }
    | undefined,
): PersonalInstallationAttribution {
  return Object.fromEntries(
    personalInstallationKeys.map((key) => {
      if (memberOverride?.[key] != null) {
        return [key, { source: "member_override" as const }];
      }
      if (organization[key]) {
        return [key, { source: "organization" as const }];
      }
      const grantingTeams: PolicySourceTeam[] = teams
        .filter((team) => team[key])
        .map((team) => ({
          id: team.team_id,
          name: team.team_name,
          slug: team.team_slug,
        }));
      return grantingTeams.length > 0
        ? [key, { source: "team" as const, teams: grantingTeams }]
        : [key, { source: "organization" as const }];
    }),
  ) as unknown as PersonalInstallationAttribution;
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

export function managedCatalogWithAttribution(
  organizationCatalog: ManagedCatalogItem[],
  teamCatalog: TeamCatalogContribution[],
  memberCatalog: ManagedCatalogItem[],
): {
  attribution: ManagedCatalogItemAttribution[];
  managedCatalog: ManagedCatalogItem[];
} {
  const identities = new Set<string>();
  const organization = new Map<string, boolean>();
  const teams = new Map<string, PolicySourceTeam[]>();
  const member = new Map<string, boolean>();
  const itemByIdentity = new Map<
    string,
    Pick<ManagedCatalogItem, "id" | "type">
  >();

  const remember = (item: Pick<ManagedCatalogItem, "id" | "type">) => {
    const identity = `${item.type}:${item.id}`;
    identities.add(identity);
    itemByIdentity.set(identity, { id: item.id, type: item.type });
    return identity;
  };

  for (const item of organizationCatalog) {
    const identity = remember(item);
    if (item.enabled) organization.set(identity, true);
  }
  for (const item of teamCatalog) {
    const identity = remember(item);
    if (!item.enabled) continue;
    const contributors = teams.get(identity) ?? [];
    if (!contributors.some((team) => team.id === item.team.id)) {
      contributors.push(item.team);
      contributors.sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }) || left.slug.localeCompare(right.slug),
      );
    }
    teams.set(identity, contributors);
  }
  for (const item of memberCatalog) {
    member.set(remember(item), item.enabled);
  }

  const attribution = [...identities]
    .sort()
    .map((identity): ManagedCatalogItemAttribution => {
      const item = itemByIdentity.get(identity)!;
      const organizationAssigned = organization.get(identity) === true;
      const grantingTeams = teams.get(identity) ?? [];
      const memberOverride = member.get(identity);
      const enabled =
        memberOverride ?? (organizationAssigned || grantingTeams.length > 0);
      return {
        enabled,
        id: item.id,
        ...(memberOverride === undefined ? {} : { memberOverride }),
        organizationAssigned,
        source:
          memberOverride !== undefined
            ? "member_override"
            : organizationAssigned
              ? "organization"
              : "team",
        teams: grantingTeams,
        type: item.type,
      };
    });

  return {
    attribution,
    managedCatalog: attribution.map(({ enabled, id, type }) => ({
      enabled,
      id,
      type,
    })),
  };
}

export function validateCatalog(items: ManagedCatalogItem[]): void {
  const identities = new Set<string>();
  for (const item of items) {
    const identity = `${item.type}:${item.id}`;
    if (identities.has(identity)) {
      throw new IdentityError(
        400,
        "duplicate_catalog_item",
        "A catalog item may only appear once in a policy.",
      );
    }
    identities.add(identity);
    try {
      assertCatalogItem(item.type, item.id);
    } catch {
      throw new IdentityError(
        400,
        "unknown_catalog_item",
        "The policy contains an item that is not in this Lori release.",
      );
    }
  }
}

export function organizationAssignments(
  items: ManagedCatalogItem[],
): ManagedCatalogItem[] {
  return items
    .filter((item) => item.enabled)
    .sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    );
}

export function resolveMemberPolicy(
  organization: OrganizationPolicy,
  personalOverrides:
    | {
        plugins: boolean | null;
        providers: boolean | null;
        skills: boolean | null;
      }
    | undefined,
  catalogOverrides: ManagedCatalogItem[],
): OrganizationPolicy {
  const merged = new Map(
    organization.managedCatalog.map((item) => [
      `${item.type}:${item.id}`,
      item,
    ]),
  );
  for (const item of catalogOverrides) {
    merged.set(`${item.type}:${item.id}`, item);
  }
  return {
    ...organization,
    managedCatalog: [...merged.values()].sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    ),
    personalInstallations: {
      plugins:
        personalOverrides?.plugins ??
        organization.personalInstallations.plugins,
      providers:
        personalOverrides?.providers ??
        organization.personalInstallations.providers,
      skills:
        personalOverrides?.skills ?? organization.personalInstallations.skills,
    },
  };
}

export function resolveTeamAwareMemberPolicy(
  organization: OrganizationPolicy,
  teamPersonal: TeamPersonalContributionRow | undefined,
  teamCatalog: ManagedCatalogItem[],
  memberPersonal:
    | {
        plugins: boolean | null;
        providers: boolean | null;
        skills: boolean | null;
      }
    | undefined,
  memberCatalog: ManagedCatalogItem[],
): OrganizationPolicy {
  const catalog = new Map(
    organization.managedCatalog.map((item) => [
      `${item.type}:${item.id}`,
      item,
    ]),
  );
  for (const item of teamCatalog) {
    if (item.enabled) {
      catalog.set(`${item.type}:${item.id}`, item);
    }
  }
  const organizationAndTeams: OrganizationPolicy = {
    ...organization,
    managedCatalog: [...catalog.values()].sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    ),
    personalInstallations: {
      plugins:
        organization.personalInstallations.plugins ||
        Boolean(teamPersonal?.plugins),
      providers:
        organization.personalInstallations.providers ||
        Boolean(teamPersonal?.providers),
      skills:
        organization.personalInstallations.skills ||
        Boolean(teamPersonal?.skills),
    },
  };
  return resolveMemberPolicy(
    organizationAndTeams,
    memberPersonal,
    memberCatalog,
  );
}

export function memberPolicyOverridesChanged(
  current: MemberPolicyOverrides,
  next: MemberPolicyOverrides,
): boolean {
  const sortCatalog = (items: ManagedCatalogItem[]) =>
    [...items].sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    );
  return (
    current.personalInstallations.plugins !==
      next.personalInstallations.plugins ||
    current.personalInstallations.providers !==
      next.personalInstallations.providers ||
    current.personalInstallations.skills !==
      next.personalInstallations.skills ||
    JSON.stringify(sortCatalog(current.managedCatalog)) !==
      JSON.stringify(sortCatalog(next.managedCatalog))
  );
}

function deviceContract(row: {
  app_version: string;
  created_at: Date;
  current_policy_revision: string;
  email: string;
  id: string;
  work_inventory?: Device["workInventory"];
  inventory: DesktopInventoryItem[];
  inventory_policy_revision: string | null;
  inventory_reported_at: Date | null;
  inventory_sync_error: string | null;
  inventory_sync_status: "synced" | "error" | null;
  last_seen_at: Date | null;
  name: string;
  owner_name: string;
  platform: DesktopPlatform;
  revoked_at: Date | null;
  status: Device["status"];
  user_id: string;
}): Device {
  return {
    appVersion: row.app_version,
    createdAt: row.created_at.toISOString(),
    currentPolicyRevision: Number(row.current_policy_revision),
    id: row.id,
    ...(row.work_inventory ? { workInventory: row.work_inventory } : {}),
    ...(row.inventory_reported_at &&
    row.inventory_policy_revision &&
    row.inventory_sync_status
      ? {
          inventory: {
            items: row.inventory,
            policyRevision: Number(row.inventory_policy_revision),
            reportedAt: row.inventory_reported_at.toISOString(),
            syncError: row.inventory_sync_error,
            syncStatus: row.inventory_sync_status,
          },
        }
      : {}),
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at.toISOString() } : {}),
    name: row.name,
    owner: {
      email: row.email,
      name: row.owner_name,
      userId: row.user_id,
    },
    platform: row.platform,
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
    status: row.status,
  };
}

export class EnrollmentService {
  public constructor(
    private readonly pool: Pool,
    private readonly auth: LoriAuth,
    private readonly config: AppConfig,
  ) {}

  private async browserMember(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<MemberRow> {
    const session = (await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    })) as BrowserSession | null;
    if (!session) {
      throw new IdentityError(401, "unauthenticated", "Sign in is required.");
    }

    const result = await database.query<MemberRow>(
      `
        SELECT
          users.id AS user_id,
          users.name,
          users.email,
          members.id AS member_id,
          members.role,
          organizations.id AS organization_id,
          organizations.name AS organization_name
        FROM "user" users
        JOIN member members ON members."userId" = users.id
        JOIN organization organizations
          ON organizations.id = members."organizationId"
        WHERE users.id = $1
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
    return { ...row, role: role(row.role) };
  }

  private async admin(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<MemberRow> {
    const member = await this.browserMember(headers, database);
    if (!isOrganizationAdministrator(member.role)) {
      throw new IdentityError(
        403,
        "admin_required",
        "Administrator access is required.",
      );
    }
    return member;
  }

  private async revalidateBrowserMember(
    headers: IncomingHttpHeaders,
    expected: MemberRow,
    database: PoolClient,
    adminRequired: boolean,
  ): Promise<void> {
    const current = adminRequired
      ? await this.admin(headers, database)
      : await this.browserMember(headers, database);
    if (
      current.user_id !== expected.user_id ||
      current.organization_id !== expected.organization_id
    ) {
      throw new IdentityError(
        403,
        adminRequired ? "admin_required" : "membership_required",
        adminRequired
          ? "Administrator access is required."
          : "This account does not belong to the organization.",
      );
    }
    Object.assign(expected, current);
  }

  private async policyForOrganization(
    organizationId: string,
    database: Pool | PoolClient = this.pool,
  ): Promise<OrganizationPolicy> {
    const result = await database.query<PolicyRow>(
      `
        SELECT
          policies.revision::text,
          policies.allow_personal_plugins,
          policies.allow_personal_providers,
          policies.allow_personal_skills,
          policies.updated_at,
          users.name AS updated_by_name
        FROM organization_policies policies
        LEFT JOIN "user" users ON users.id = policies.updated_by_user_id
        WHERE policies.organization_id = $1
      `,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        503,
        "policy_unavailable",
        "Organization policy has not been initialized.",
      );
    }
    const catalog = await database.query<CatalogPolicyRow>(
      `
        SELECT item_type, item_id, enabled
        FROM organization_catalog_policies
        WHERE organization_id = $1 AND enabled = TRUE
      `,
      [organizationId],
    );
    return policyContract(row, catalogContract(catalog.rows));
  }

  public async effectivePolicyForMember(
    organizationId: string,
    memberId: string,
    database: Pool | PoolClient = this.pool,
  ): Promise<OrganizationPolicy> {
    return (
      await this.policyLayersForMember(organizationId, memberId, database)
    ).effective;
  }

  /** What team grants may contain: stored approvals plus the organization defaults. */
  public async codeDelegationCeiling(
    organizationId: string,
    database: Pool | PoolClient = this.pool,
    organization?: OrganizationPolicy,
  ): Promise<EffectiveCodeDelegation> {
    const stored = await database.query<{ delegation: unknown }>(
      "SELECT delegation FROM organization_policies WHERE organization_id = $1",
      [organizationId],
    );
    return effectiveCodeDelegation(
      storedCodeDelegation(stored.rows[0]?.delegation),
      organization ??
        (await this.policyForOrganization(organizationId, database)),
    );
  }

  public async getCodeDelegation(
    headers: IncomingHttpHeaders,
  ): Promise<CodeDelegationPolicy> {
    const member = await this.admin(headers);
    const row = await this.pool.query<{ delegation: unknown; revision: string }>(
      "SELECT delegation, revision::text FROM organization_policies WHERE organization_id = $1",
      [member.organization_id],
    );
    const stored = storedCodeDelegation(row.rows[0]?.delegation);
    return {
      ...stored,
      effective: effectiveCodeDelegation(
        stored,
        await this.policyForOrganization(member.organization_id),
      ),
      revision: Number(row.rows[0]?.revision ?? 0),
    };
  }

  public async updateCodeDelegation(
    headers: IncomingHttpHeaders,
    expectedRevision: number,
    input: EffectiveCodeDelegation,
  ): Promise<CodeDelegationPolicy> {
    const next = normalizeCodeDelegation(CodeDelegationSchema.parse(input));
    validateCatalog(next.managedCatalog.map((item) => ({ ...item, enabled: true })));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const member = await this.admin(headers, client);
      const current = await client.query<{ delegation: unknown; revision: string }>(
        `
          SELECT delegation, revision::text FROM organization_policies
          WHERE organization_id = $1 FOR UPDATE
        `,
        [member.organization_id],
      );
      await this.revalidateBrowserMember(headers, member, client, true);
      if (Number(current.rows[0]?.revision) !== expectedRevision) {
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Organization policy changed. Reload before saving again.",
        );
      }
      const previous = storedCodeDelegation(current.rows[0]?.delegation);
      let revision = expectedRevision;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        const updated = await client.query<{ revision: string }>(
          `
            UPDATE organization_policies
            SET delegation = $2::jsonb, revision = revision + 1,
              updated_at = NOW(), updated_by_user_id = $3
            WHERE organization_id = $1
            RETURNING revision::text
          `,
          [member.organization_id, storedDocument(next), member.user_id],
        );
        revision = Number(updated.rows[0]?.revision);
        await recordAuditEvent(client, {
          action: "organization.delegation_updated",
          actorUserId: member.user_id,
          organizationId: member.organization_id,
          metadata: { product: "code", before: previous, after: next },
          subjectId: member.organization_id,
          subjectType: "organization",
        });
      }
      await client.query("COMMIT");
      return { ...next, revision };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async policyLayersForMember(
    organizationId: string,
    memberId: string,
    database: Pool | PoolClient = this.pool,
  ): Promise<{
    effective: OrganizationPolicy;
    inherited: OrganizationPolicy;
    organization: OrganizationPolicy;
  }> {
    const organization = await this.policyForOrganization(
      organizationId,
      database,
    );
    const overrideResult = await database.query<MemberPolicyOverrideRow>(
      `
        SELECT
          allow_personal_plugins,
          allow_personal_providers,
          allow_personal_skills
        FROM member_policy_overrides
        WHERE member_id = $1
      `,
      [memberId],
    );
    const catalogResult = await database.query<CatalogPolicyRow>(
      `
        SELECT item_type, item_id, enabled
        FROM member_catalog_overrides
        WHERE member_id = $1
      `,
      [memberId],
    );
    const teamPersonalResult =
      await database.query<TeamPersonalContributionDetailRow>(
        `
          SELECT
            teams.id AS team_id,
            teams.name AS team_name,
            teams.slug AS team_slug,
            COALESCE(
              overrides.allow_personal_plugins,
              policies.allow_personal_plugins
            ) AS plugins,
            COALESCE(
              overrides.allow_personal_providers,
              policies.allow_personal_providers
            ) AS providers,
            COALESCE(
              overrides.allow_personal_skills,
              policies.allow_personal_skills
            ) AS skills
          FROM team_member memberships
          JOIN team teams ON teams.id = memberships.team_id
          JOIN team_policies policies ON policies.team_id = memberships.team_id
          LEFT JOIN team_member_policy_overrides overrides
            ON overrides.team_member_id = memberships.id
          WHERE memberships.member_id = $1
            AND teams.organization_id = $2
          ORDER BY lower(teams.name), teams.slug
        `,
        [memberId, organizationId],
      );
    const teamCatalogResult = await database.query<TeamCatalogContributionRow>(
      `
        WITH identities AS (
          SELECT
            memberships.id AS team_member_id,
            memberships.team_id,
            policies.item_type,
            policies.item_id
          FROM team_member memberships
          JOIN team teams_scope ON teams_scope.id = memberships.team_id
          JOIN team_catalog_policies policies
            ON policies.team_id = memberships.team_id
          WHERE memberships.member_id = $1
            AND teams_scope.organization_id = $2

          UNION

          SELECT
            memberships.id AS team_member_id,
            memberships.team_id,
            overrides.item_type,
            overrides.item_id
          FROM team_member memberships
          JOIN team teams_scope ON teams_scope.id = memberships.team_id
          JOIN team_member_catalog_overrides overrides
            ON overrides.team_member_id = memberships.id
          WHERE memberships.member_id = $1
            AND teams_scope.organization_id = $2
        )
        SELECT
          identities.item_type,
          identities.item_id,
          COALESCE(overrides.enabled, policies.enabled, FALSE) AS enabled,
          teams.id AS team_id,
          teams.name AS team_name,
          teams.slug AS team_slug
        FROM identities
        JOIN team teams ON teams.id = identities.team_id
        LEFT JOIN team_catalog_policies policies
          ON policies.team_id = identities.team_id
          AND policies.item_type = identities.item_type
          AND policies.item_id = identities.item_id
        LEFT JOIN team_member_catalog_overrides overrides
          ON overrides.team_member_id = identities.team_member_id
          AND overrides.item_type = identities.item_type
          AND overrides.item_id = identities.item_id
        ORDER BY identities.item_type, identities.item_id, lower(teams.name), teams.slug
      `,
      [memberId, organizationId],
    );
    const override = overrideResult.rows[0];
    // Team grants count only within the organization's delegation ceiling.
    const ceiling = await this.codeDelegationCeiling(
      organizationId,
      database,
      organization,
    );
    const boundedTeamPersonal = teamPersonalResult.rows.map((team) => ({
      ...team,
      plugins: team.plugins && ceiling.personalInstallations.plugins,
      providers: team.providers && ceiling.personalInstallations.providers,
      skills: team.skills && ceiling.personalInstallations.skills,
    }));
    const teamPersonal = {
      plugins: boundedTeamPersonal.some((team) => team.plugins),
      providers: boundedTeamPersonal.some((team) => team.providers),
      skills: boundedTeamPersonal.some((team) => team.skills),
    };
    const teamCatalogContributions: TeamCatalogContribution[] =
      teamCatalogResult.rows.map((row) => ({
        enabled:
          row.enabled &&
          catalogApproved(ceiling, { id: row.item_id, type: row.item_type }),
        id: row.item_id,
        team: {
          id: row.team_id,
          name: row.team_name,
          slug: row.team_slug,
        },
        type: row.item_type,
      }));
    const inheritedCatalog = managedCatalogWithAttribution(
      organization.managedCatalog,
      teamCatalogContributions,
      [],
    );
    const inheritedResolved = resolveTeamAwareMemberPolicy(
      organization,
      teamPersonal,
      inheritedCatalog.managedCatalog.filter((item) =>
        inheritedCatalog.attribution.some(
          (source) =>
            source.id === item.id &&
            source.type === item.type &&
            source.teams.length > 0,
        ),
      ),
      undefined,
      [],
    );
    const inherited: OrganizationPolicy = {
      ...inheritedResolved,
      managedCatalogAttribution: inheritedCatalog.attribution,
      personalInstallationAttribution: personalInstallationAttribution(
        organization.personalInstallations,
        boundedTeamPersonal,
        undefined,
      ),
    };
    const effectiveCatalog = managedCatalogWithAttribution(
      organization.managedCatalog,
      teamCatalogContributions,
      catalogContract(catalogResult.rows),
    );
    const effectiveResolved = resolveMemberPolicy(
      inherited,
      override
        ? {
            plugins: override.allow_personal_plugins,
            providers: override.allow_personal_providers,
            skills: override.allow_personal_skills,
          }
        : undefined,
      effectiveCatalog.managedCatalog,
    );
    const effective: OrganizationPolicy = {
      ...effectiveResolved,
      managedCatalogAttribution: effectiveCatalog.attribution,
      personalInstallationAttribution: personalInstallationAttribution(
        organization.personalInstallations,
        boundedTeamPersonal,
        override
          ? {
              plugins: override.allow_personal_plugins,
              providers: override.allow_personal_providers,
              skills: override.allow_personal_skills,
            }
          : undefined,
      ),
    };
    return { effective, inherited, organization };
  }

  public async getPolicy(
    headers: IncomingHttpHeaders,
  ): Promise<OrganizationPolicy> {
    const member = await this.browserMember(headers);
    return this.effectivePolicyForMember(
      member.organization_id,
      member.member_id,
    );
  }

  public async getOrganizationPolicy(
    headers: IncomingHttpHeaders,
  ): Promise<OrganizationPolicy> {
    const member = await this.admin(headers);
    return this.policyForOrganization(member.organization_id);
  }

  public async getCatalog(
    headers: IncomingHttpHeaders,
  ): Promise<PolicyCatalog> {
    const member = await this.browserMember(headers);
    const connected = await this.pool.query<{ provider_id: string }>(
      `
        SELECT provider_id
        FROM organization_provider_gateways
        WHERE organization_id = $1
        ORDER BY provider_id
      `,
      [member.organization_id],
    );
    return {
      ...policyCatalog,
      connectedOrganizationProviderIds: connected.rows.map(
        (row) => row.provider_id,
      ),
    };
  }

  public async updatePolicy(
    headers: IncomingHttpHeaders,
    expectedRevision: number,
    personalInstallations: PersonalInstallationPolicy,
    managedCatalog: ManagedCatalogItem[],
  ): Promise<OrganizationPolicy> {
    validateCatalog(managedCatalog);
    const assignments = organizationAssignments(managedCatalog);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const member = await this.admin(headers, client);
      const current = await client.query<PolicyRow>(
        `
          SELECT
            revision::text,
            allow_personal_plugins,
            allow_personal_providers,
            allow_personal_skills,
            updated_at,
            NULL::text AS updated_by_name
          FROM organization_policies
          WHERE organization_id = $1
          FOR UPDATE
        `,
        [member.organization_id],
      );
      const currentRow = current.rows[0];
      if (!currentRow) {
        throw new IdentityError(
          503,
          "policy_unavailable",
          "Organization policy is unavailable.",
        );
      }
      await this.revalidateBrowserMember(headers, member, client, true);
      if (Number(currentRow.revision) !== expectedRevision) {
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Organization policy changed. Reload before saving again.",
        );
      }

      const currentCatalog = await client.query<CatalogPolicyRow>(
        `
          SELECT item_type, item_id, enabled
          FROM organization_catalog_policies
          WHERE organization_id = $1
        `,
        [member.organization_id],
      );
      const currentCatalogJson = JSON.stringify(
        catalogContract(currentCatalog.rows),
      );
      const nextCatalogJson = JSON.stringify(assignments);
      const changed =
        currentRow.allow_personal_plugins !== personalInstallations.plugins ||
        currentRow.allow_personal_providers !==
          personalInstallations.providers ||
        currentRow.allow_personal_skills !== personalInstallations.skills ||
        currentCatalogJson !== nextCatalogJson;
      if (changed) {
        await client.query(
          `
            UPDATE organization_policies
            SET
              revision = revision + 1,
              allow_personal_plugins = $2,
              allow_personal_providers = $3,
              allow_personal_skills = $4,
              updated_at = NOW(),
              updated_by_user_id = $5
            WHERE organization_id = $1
          `,
          [
            member.organization_id,
            personalInstallations.plugins,
            personalInstallations.providers,
            personalInstallations.skills,
            member.user_id,
          ],
        );
        await client.query(
          "DELETE FROM organization_catalog_policies WHERE organization_id = $1",
          [member.organization_id],
        );
        for (const item of assignments) {
          await client.query(
            `
              INSERT INTO organization_catalog_policies (
                organization_id, item_type, item_id, enabled, updated_by_user_id
              )
              VALUES ($1, $2, $3, $4, $5)
            `,
            [
              member.organization_id,
              item.type,
              item.id,
              item.enabled,
              member.user_id,
            ],
          );
        }
        await recordAuditEvent(client, {
          action: "organization.policy_updated",
          actorUserId: member.user_id,
          organizationId: member.organization_id,
          metadata: {
            personalPlugins: personalInstallations.plugins,
            personalProviders: personalInstallations.providers,
            personalSkills: personalInstallations.skills,
            managedCatalogItems: assignments.length,
            previousRevision: expectedRevision,
          },
          subjectId: member.organization_id,
          subjectType: "organization",
        });
      }
      const policy = await this.policyForOrganization(
        member.organization_id,
        client,
      );
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async getMemberPolicy(
    headers: IncomingHttpHeaders,
    memberId: string,
  ): Promise<MemberPolicy> {
    const admin = await this.admin(headers);
    return this.memberPolicyForOrganization(
      admin.organization_id,
      memberId,
      this.pool,
    );
  }

  private async memberPolicyForOrganization(
    organizationId: string,
    memberId: string,
    database: Pool | PoolClient,
  ): Promise<MemberPolicy> {
    const target = await this.memberForPolicy(
      organizationId,
      memberId,
      database,
    );
    const layers = await this.policyLayersForMember(
      organizationId,
      memberId,
      database,
    );
    const overrideResult = await database.query<MemberPolicyOverrideRow>(
      `
        SELECT
          allow_personal_plugins,
          allow_personal_providers,
          allow_personal_skills
        FROM member_policy_overrides
        WHERE member_id = $1
      `,
      [memberId],
    );
    const catalogResult = await database.query<CatalogPolicyRow>(
      `
        SELECT item_type, item_id, enabled
        FROM member_catalog_overrides
        WHERE member_id = $1
      `,
      [memberId],
    );
    const override = overrideResult.rows[0];
    return {
      effective: layers.effective,
      inherited: layers.inherited,
      member: target,
      organization: layers.organization,
      overrides: {
        managedCatalog: catalogContract(catalogResult.rows),
        personalInstallations: {
          plugins: override?.allow_personal_plugins ?? null,
          providers: override?.allow_personal_providers ?? null,
          skills: override?.allow_personal_skills ?? null,
        },
      },
    };
  }

  private async memberForPolicy(
    organizationId: string,
    memberId: string,
    database: Pool | PoolClient,
  ): Promise<Person> {
    const result = await database.query<{
      created_at: Date;
      current_policy_revision: string;
      email: string;
      member_id: string;
      name: string;
      role: Role;
      user_id: string;
    }>(
      `
        SELECT
          members.id AS member_id,
          members.role,
          members."createdAt" AS created_at,
          users.id AS user_id,
          users.name,
          users.email
        FROM member members
        JOIN "user" users ON users.id = members."userId"
        WHERE members.id = $1 AND members."organizationId" = $2
      `,
      [memberId, organizationId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(404, "member_not_found", "Member not found.");
    }
    return {
      createdAt: row.created_at.toISOString(),
      email: row.email,
      memberId: row.member_id,
      name: row.name,
      role: role(row.role),
      userId: row.user_id,
    };
  }

  public async updateMemberPolicy(
    headers: IncomingHttpHeaders,
    memberId: string,
    expectedRevision: number,
    overrides: MemberPolicyOverrides,
  ): Promise<MemberPolicy> {
    validateCatalog(overrides.managedCatalog);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const admin = await this.admin(headers, client);
      const policy = await client.query<{ revision: string }>(
        `
          SELECT revision::text
          FROM organization_policies
          WHERE organization_id = $1
          FOR UPDATE
        `,
        [admin.organization_id],
      );
      await this.revalidateBrowserMember(headers, admin, client, true);
      if (Number(policy.rows[0]?.revision) !== expectedRevision) {
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Organization policy changed. Reload before saving again.",
        );
      }
      const target = await this.memberForPolicy(
        admin.organization_id,
        memberId,
        client,
      );
      const currentPersonal = await client.query<MemberPolicyOverrideRow>(
        `
          SELECT
            allow_personal_plugins,
            allow_personal_providers,
            allow_personal_skills
          FROM member_policy_overrides
          WHERE member_id = $1
        `,
        [memberId],
      );
      const currentCatalog = await client.query<CatalogPolicyRow>(
        `
          SELECT item_type, item_id, enabled
          FROM member_catalog_overrides
          WHERE member_id = $1
        `,
        [memberId],
      );
      const currentOverride = currentPersonal.rows[0];
      const nextCatalog = [...overrides.managedCatalog].sort((left, right) =>
        `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
      );
      const changed = memberPolicyOverridesChanged(
        {
          managedCatalog: catalogContract(currentCatalog.rows),
          personalInstallations: {
            plugins: currentOverride?.allow_personal_plugins ?? null,
            providers: currentOverride?.allow_personal_providers ?? null,
            skills: currentOverride?.allow_personal_skills ?? null,
          },
        },
        { ...overrides, managedCatalog: nextCatalog },
      );

      if (changed) {
        const hasPersonalOverride = Object.values(
          overrides.personalInstallations,
        ).some((value) => value !== null);
        if (hasPersonalOverride) {
          await client.query(
            `
              INSERT INTO member_policy_overrides (
                member_id,
                allow_personal_plugins,
                allow_personal_providers,
                allow_personal_skills,
                updated_by_user_id
              )
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (member_id) DO UPDATE SET
                allow_personal_plugins = EXCLUDED.allow_personal_plugins,
                allow_personal_providers = EXCLUDED.allow_personal_providers,
                allow_personal_skills = EXCLUDED.allow_personal_skills,
                updated_at = NOW(),
                updated_by_user_id = EXCLUDED.updated_by_user_id
            `,
            [
              memberId,
              overrides.personalInstallations.plugins,
              overrides.personalInstallations.providers,
              overrides.personalInstallations.skills,
              admin.user_id,
            ],
          );
        } else {
          await client.query(
            "DELETE FROM member_policy_overrides WHERE member_id = $1",
            [memberId],
          );
        }
        await client.query(
          "DELETE FROM member_catalog_overrides WHERE member_id = $1",
          [memberId],
        );
        for (const item of nextCatalog) {
          await client.query(
            `
              INSERT INTO member_catalog_overrides (
                member_id, item_type, item_id, enabled, updated_by_user_id
              )
              VALUES ($1, $2, $3, $4, $5)
            `,
            [memberId, item.type, item.id, item.enabled, admin.user_id],
          );
        }
        await client.query(
          `
            UPDATE organization_policies
            SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $2
            WHERE organization_id = $1
          `,
          [admin.organization_id, admin.user_id],
        );
        await recordAuditEvent(client, {
          action: "member.policy_updated",
          actorUserId: admin.user_id,
          organizationId: admin.organization_id,
          metadata: {
            catalogOverrides: nextCatalog.length,
            previousRevision: expectedRevision,
          },
          subjectId: memberId,
          subjectType: "member",
        });
      }
      const result = await this.memberPolicyForOrganization(
        admin.organization_id,
        target.memberId,
        client,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async resetMemberPolicy(
    headers: IncomingHttpHeaders,
    memberId: string,
    expectedRevision: number,
  ): Promise<MemberPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const admin = await this.admin(headers, client);
      const policy = await client.query<{ revision: string }>(
        `
          SELECT revision::text
          FROM organization_policies
          WHERE organization_id = $1
          FOR UPDATE
        `,
        [admin.organization_id],
      );
      await this.revalidateBrowserMember(headers, admin, client, true);
      if (Number(policy.rows[0]?.revision) !== expectedRevision) {
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Organization policy changed. Reload before saving again.",
        );
      }
      await this.memberForPolicy(admin.organization_id, memberId, client);
      const personal = await client.query(
        "DELETE FROM member_policy_overrides WHERE member_id = $1 RETURNING member_id",
        [memberId],
      );
      const catalog = await client.query(
        "DELETE FROM member_catalog_overrides WHERE member_id = $1 RETURNING member_id",
        [memberId],
      );
      if (personal.rowCount || catalog.rowCount) {
        await client.query(
          `
            UPDATE organization_policies
            SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $2
            WHERE organization_id = $1
          `,
          [admin.organization_id, admin.user_id],
        );
        await recordAuditEvent(client, {
          action: "member.policy_reset",
          actorUserId: admin.user_id,
          organizationId: admin.organization_id,
          metadata: { previousRevision: expectedRevision },
          subjectId: memberId,
          subjectType: "member",
        });
      }
      const result = await this.memberPolicyForOrganization(
        admin.organization_id,
        memberId,
        client,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async authorize(
    headers: IncomingHttpHeaders,
    input: AuthorizeEnrollmentInput,
  ): Promise<EnrollmentAuthorization> {
    const member = await this.browserMember(headers);
    if (
      input.expectedOrganizationId &&
      input.expectedOrganizationId !== member.organization_id
    ) {
      throw new IdentityError(
        409,
        "workspace_changed",
        "Your workspace changed in another tab. Reload this page and confirm where to connect the device.",
      );
    }
    const code = generateDesktopToken("authorization-code");
    const deviceId = randomUUID();
    const expiresAt = new Date(
      Date.now() + ENROLLMENT_CODE_LIFETIME_SECONDS * 1_000,
    );

    await this.pool.query(
      `
        WITH expired AS (
          DELETE FROM enrollment_codes
          WHERE
            expires_at < NOW() - INTERVAL '1 day'
            OR consumed_at < NOW() - INTERVAL '1 day'
        )
        INSERT INTO enrollment_codes (
          id,
          code_hash,
          organization_id,
          user_id,
          device_id,
          device_name,
          platform,
          app_version,
          code_challenge,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        randomUUID(),
        hashDesktopToken(code, this.config.auth.secret, "authorization-code"),
        member.organization_id,
        member.user_id,
        deviceId,
        input.deviceName,
        input.platform,
        input.appVersion,
        input.codeChallenge,
        expiresAt,
      ],
    );
    await recordAuditEvent(this.pool, {
      action: "device.enrollment_authorized",
      actorUserId: member.user_id,
      organizationId: member.organization_id,
      metadata: {
        appVersion: input.appVersion,
        deviceName: input.deviceName,
        platform: input.platform,
      },
      subjectId: deviceId,
      subjectType: "device",
    });

    const deepLink = new URL("lori://enroll");
    deepLink.searchParams.set("server", this.config.publicUrl);
    deepLink.searchParams.set("code", code);
    deepLink.searchParams.set("protocol", String(DESKTOP_PROTOCOL_VERSION));
    if (input.state) {
      deepLink.searchParams.set("state", input.state);
    }

    let returnUrl: string | undefined;
    if (input.callbackUrl) {
      const callback = new URL(input.callbackUrl);
      callback.searchParams.set("server", this.config.publicUrl);
      callback.searchParams.set("code", code);
      callback.searchParams.set("protocol", String(DESKTOP_PROTOCOL_VERSION));
      if (input.state) {
        callback.searchParams.set("state", input.state);
      }
      returnUrl = callback.toString();
    }

    return {
      deepLink: deepLink.toString(),
      expiresAt: expiresAt.toISOString(),
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      ...(returnUrl ? { returnUrl } : {}),
    };
  }

  public async exchange(
    input: ExchangeEnrollmentInput,
  ): Promise<EnrollmentTokenResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AuthorizationCodeRow>(
        `
          SELECT
            id::text,
            organization_id,
            user_id,
            device_id::text,
            device_name,
            platform,
            app_version,
            code_challenge,
            expires_at,
            consumed_at
          FROM enrollment_codes
          WHERE code_hash = $1
          FOR UPDATE
        `,
        [
          hashDesktopToken(
            input.code,
            this.config.auth.secret,
            "authorization-code",
          ),
        ],
      );
      const code = result.rows[0];
      if (!code) {
        throw new IdentityError(
          401,
          "invalid_enrollment_code",
          "The enrollment code is invalid.",
        );
      }
      if (code.consumed_at) {
        throw new IdentityError(
          410,
          "enrollment_code_used",
          "The enrollment code has already been used.",
        );
      }
      if (code.expires_at.getTime() <= Date.now()) {
        throw new IdentityError(
          410,
          "enrollment_code_expired",
          "The enrollment code has expired.",
        );
      }
      if (!verifyPkce(input.codeVerifier, code.code_challenge)) {
        throw new IdentityError(
          401,
          "invalid_code_verifier",
          "The enrollment verifier is invalid.",
        );
      }
      // Shares the row removal locks, so removal either sees this new device
      // and revokes it, or this exchange fails because the member is gone.
      const membership = await client.query(
        `
          SELECT 1 FROM member
          WHERE "organizationId" = $1 AND "userId" = $2
          FOR SHARE
        `,
        [code.organization_id, code.user_id],
      );
      if (!membership.rowCount) {
        throw new IdentityError(
          403,
          "membership_required",
          "Organization membership is no longer active.",
        );
      }

      await client.query(
        `
          INSERT INTO devices (
            id,
            organization_id,
            user_id,
            name,
            platform,
            app_version
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          code.device_id,
          code.organization_id,
          code.user_id,
          code.device_name,
          code.platform,
          code.app_version,
        ],
      );

      const tokens = await this.createSessionTokens(client, code.device_id);
      await client.query(
        "UPDATE enrollment_codes SET consumed_at = NOW() WHERE id = $1",
        [code.id],
      );
      await recordAuditEvent(client, {
        action: "device.enrolled",
        actorUserId: code.user_id,
        organizationId: code.organization_id,
        metadata: {
          appVersion: code.app_version,
          deviceName: code.device_name,
          platform: code.platform,
        },
        subjectId: code.device_id,
        subjectType: "device",
      });
      await client.query("COMMIT");
      return tokens;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async createSessionTokens(
    client: PoolClient,
    deviceId: string,
  ): Promise<EnrollmentTokenResponse> {
    const accessToken = generateDesktopToken("access");
    const refreshToken = generateDesktopToken("refresh");
    const sessionId = randomUUID();
    const accessExpiresAt = new Date(
      Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1_000,
    );
    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_LIFETIME_SECONDS * 1_000,
    );

    await client.query(
      `
        INSERT INTO device_sessions (
          id,
          device_id,
          token_family_id,
          access_token_hash,
          access_expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        sessionId,
        deviceId,
        randomUUID(),
        hashDesktopToken(accessToken, this.config.auth.secret, "access"),
        accessExpiresAt,
      ],
    );
    await client.query(
      `
        INSERT INTO device_refresh_tokens (
          id,
          session_id,
          token_hash,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
      `,
      [
        randomUUID(),
        sessionId,
        hashDesktopToken(refreshToken, this.config.auth.secret, "refresh"),
        refreshExpiresAt,
      ],
    );

    return {
      accessToken,
      deviceId,
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshExpiresIn: REFRESH_TOKEN_LIFETIME_SECONDS,
      refreshToken,
      tokenType: "Bearer",
    };
  }

  public async refresh(refreshToken: string): Promise<EnrollmentTokenResponse> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await client.query<RefreshRow>(
        `
          SELECT
            refresh.id::text AS refresh_id,
            refresh.expires_at,
            refresh.consumed_at,
            sessions.id::text AS session_id,
            sessions.token_family_id::text,
            sessions.revoked_at AS session_revoked_at,
            devices.id::text AS device_id,
            devices.organization_id,
            devices.user_id,
            devices.revoked_at AS device_revoked_at
          FROM device_refresh_tokens refresh
          JOIN device_sessions sessions ON sessions.id = refresh.session_id
          JOIN devices ON devices.id = sessions.device_id
          WHERE refresh.token_hash = $1
          FOR UPDATE OF refresh, sessions, devices
        `,
        [hashDesktopToken(refreshToken, this.config.auth.secret, "refresh")],
      );
      const row = result.rows[0];
      if (!row) {
        throw new IdentityError(
          401,
          "invalid_refresh_token",
          "The refresh token is invalid.",
        );
      }
      if (row.consumed_at) {
        await client.query(
          `
            UPDATE device_sessions
            SET
              revoked_at = COALESCE(revoked_at, NOW()),
              revoked_reason = COALESCE(revoked_reason, 'refresh_reuse')
            WHERE token_family_id = $1
          `,
          [row.token_family_id],
        );
        await recordAuditEvent(client, {
          action: "device.refresh_reuse_detected",
          actorUserId: row.user_id,
          organizationId: row.organization_id,
          subjectId: row.device_id,
          subjectType: "device",
        });
        await client.query("COMMIT");
        committed = true;
        throw new IdentityError(
          401,
          "refresh_token_reused",
          "This device session was revoked because a refresh token was reused.",
        );
      }
      if (
        row.expires_at.getTime() <= Date.now() ||
        row.session_revoked_at ||
        row.device_revoked_at
      ) {
        throw new IdentityError(
          401,
          "refresh_token_expired",
          "This device session is no longer active.",
        );
      }
      const membership = await client.query(
        `
          SELECT 1 FROM member
          WHERE "organizationId" = $1 AND "userId" = $2
        `,
        [row.organization_id, row.user_id],
      );
      if (!membership.rowCount) {
        await client.query(
          `
            UPDATE device_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()), revoked_reason = 'membership_removed'
            WHERE token_family_id = $1
          `,
          [row.token_family_id],
        );
        await client.query("COMMIT");
        committed = true;
        throw new IdentityError(
          403,
          "membership_required",
          "Organization membership is no longer active.",
        );
      }

      const accessToken = generateDesktopToken("access");
      const nextRefreshToken = generateDesktopToken("refresh");
      const accessExpiresAt = new Date(
        Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1_000,
      );
      const refreshExpiresAt = new Date(
        Date.now() + REFRESH_TOKEN_LIFETIME_SECONDS * 1_000,
      );
      await client.query(
        "UPDATE device_refresh_tokens SET consumed_at = NOW() WHERE id = $1",
        [row.refresh_id],
      );
      await client.query(
        `
          UPDATE device_sessions
          SET
            access_token_hash = $2,
            access_expires_at = $3,
            last_used_at = NOW()
          WHERE id = $1
        `,
        [
          row.session_id,
          hashDesktopToken(accessToken, this.config.auth.secret, "access"),
          accessExpiresAt,
        ],
      );
      await client.query(
        `
          INSERT INTO device_refresh_tokens (id, session_id, token_hash, expires_at)
          VALUES ($1, $2, $3, $4)
        `,
        [
          randomUUID(),
          row.session_id,
          hashDesktopToken(
            nextRefreshToken,
            this.config.auth.secret,
            "refresh",
          ),
          refreshExpiresAt,
        ],
      );
      await client.query(
        "UPDATE devices SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1",
        [row.device_id],
      );
      await client.query("COMMIT");
      committed = true;
      return {
        accessToken,
        deviceId: row.device_id,
        expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
        refreshExpiresIn: REFRESH_TOKEN_LIFETIME_SECONDS,
        refreshToken: nextRefreshToken,
        tokenType: "Bearer",
      };
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async access(authorization: string | undefined): Promise<AccessRow> {
    const token = readBearerToken(authorization);
    if (!token) {
      throw new IdentityError(
        401,
        "device_authentication_required",
        "A valid device bearer token is required.",
      );
    }
    const result = await this.pool.query<AccessRow>(
      `
        SELECT
          sessions.id::text AS session_id,
          sessions.access_expires_at,
          sessions.revoked_at AS session_revoked_at,
          devices.id::text AS device_id,
          devices.name AS device_name,
          devices.platform,
          devices.app_version,
          devices.revoked_at AS device_revoked_at,
          organizations.id AS organization_id,
          organizations.name AS organization_name,
          users.id AS user_id,
          users.name,
          users.email,
          members.id AS member_id,
          members.role
        FROM device_sessions sessions
        JOIN devices ON devices.id = sessions.device_id
        JOIN organization organizations ON organizations.id = devices.organization_id
        JOIN "user" users ON users.id = devices.user_id
        JOIN member members
          ON members."organizationId" = devices.organization_id
          AND members."userId" = devices.user_id
        WHERE sessions.access_token_hash = $1
        LIMIT 1
      `,
      [hashDesktopToken(token, this.config.auth.secret, "access")],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.access_expires_at.getTime() <= Date.now() ||
      row.session_revoked_at ||
      row.device_revoked_at
    ) {
      throw new IdentityError(
        401,
        "device_session_expired",
        "The device session is expired or revoked.",
      );
    }
    await Promise.all([
      this.pool.query(
        `
          UPDATE device_sessions
          SET last_used_at = NOW()
          WHERE id = $1
            AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')
        `,
        [row.session_id],
      ),
      this.pool.query(
        `
          UPDATE devices
          SET last_seen_at = NOW(), updated_at = NOW()
          WHERE id = $1
            AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '1 minute')
        `,
        [row.device_id],
      ),
    ]);
    return { ...row, role: role(row.role) };
  }

  public async authenticatedDevice(
    authorization: string | undefined,
  ): Promise<DesktopAccess> {
    const access = await this.access(authorization);
    return {
      sessionId: access.session_id,
      deviceId: access.device_id,
      memberId: access.member_id,
      organizationId: access.organization_id,
      userId: access.user_id,
    };
  }

  public async desktopUpdateState(
    authorization: string | undefined,
  ): Promise<DesktopUpdateState> {
    const access = await this.access(authorization);
    const revision = await this.currentPolicyRevision(access.organization_id);
    return {
      deviceId: access.device_id,
      organizationId: access.organization_id,
      revision,
    };
  }

  public async currentPolicyRevision(organizationId: string): Promise<number> {
    const result = await this.pool.query<{ revision: string }>(
      `SELECT revision::text FROM organization_policies WHERE organization_id = $1`,
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
    return revision;
  }

  public async bootstrap(
    authorization: string | undefined,
  ): Promise<{ bootstrap: DesktopBootstrap; etag: string }> {
    const access = await this.access(authorization);
    const policy = await this.effectivePolicyForMember(
      access.organization_id,
      access.member_id,
    );
    const teams = await this.pool.query<TeamSummary & { member_count: string }>(
      `
        SELECT
          teams.id,
          teams.name,
          teams.slug,
          COUNT(all_members.id)::text AS member_count
        FROM team_member memberships
        JOIN team teams ON teams.id = memberships.team_id
        LEFT JOIN team_member all_members ON all_members.team_id = teams.id
        WHERE memberships.member_id = $1
          AND teams.organization_id = $2
        GROUP BY teams.id
        ORDER BY lower(teams.name), teams.slug
      `,
      [access.member_id, access.organization_id],
    );
    return {
      bootstrap: {
        device: {
          appVersion: access.app_version,
          id: access.device_id,
          name: access.device_name,
          platform: access.platform,
        },
        managedCatalog: policy.managedCatalog,
        organization: {
          id: access.organization_id,
          name: access.organization_name,
        },
        policy,
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        server: {
          origin: this.config.publicUrl,
          version: this.config.version,
        },
        teams: teams.rows.map((team) => ({
          id: team.id,
          memberCount: Number(team.member_count),
          name: team.name,
          slug: team.slug,
        })),
        user: {
          email: access.email,
          id: access.user_id,
          name: access.name,
          // Older desktops reject unknown roles; the Owner keeps admin authority there.
          role: legacyOrganizationRole(access.role),
          organizationRole: access.role,
          capabilities: organizationCapabilities(access.role),
        },
      },
      etag: desktopPolicyEtag(policy.revision),
    };
  }

  public async reportDesktopInventory(
    authorization: string | undefined,
    report: DesktopInventoryReport,
  ): Promise<void> {
    const access = await this.access(authorization);
    const items = [...report.items]
      .map((item) => ({
        ...item,
        enabledAgents: [...item.enabledAgents].sort(),
      }))
      .sort((left, right) =>
        `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
      );
    await this.pool.query(
      `
        UPDATE devices
        SET
          inventory = $2::jsonb,
          inventory_policy_revision = $3,
          inventory_reported_at = NOW(),
          inventory_sync_status = $4,
          inventory_sync_error = $5,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        access.device_id,
        JSON.stringify(items),
        report.policyRevision,
        report.syncStatus,
        report.syncError,
      ],
    );
  }

  public async disconnect(authorization: string | undefined): Promise<void> {
    const access = await this.access(authorization);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE devices
          SET
            revoked_at = COALESCE(revoked_at, NOW()),
            revoked_by_user_id = $2,
            revoked_reason = COALESCE(revoked_reason, 'desktop_disconnect'),
            updated_at = NOW()
          WHERE id = $1
        `,
        [access.device_id, access.user_id],
      );
      const revoked = await client.query(
        `
          UPDATE device_sessions
          SET
            revoked_at = COALESCE(revoked_at, NOW()),
            revoked_reason = COALESCE(revoked_reason, 'desktop_disconnect')
          WHERE device_id = $1 AND revoked_at IS NULL
          RETURNING id
        `,
        [access.device_id],
      );
      await recordAuditEvent(client, {
        action: "device.disconnected",
        actorUserId: access.user_id,
        organizationId: access.organization_id,
        metadata: { revokedSessions: revoked.rowCount ?? 0 },
        subjectId: access.device_id,
        subjectType: "device",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async devices(
    member: MemberRow,
    organizationWide: boolean,
  ): Promise<DevicesResponse> {
    const result = await this.pool.query<{
      app_version: string;
      created_at: Date;
      current_policy_revision: string;
      email: string;
      id: string;
      work_inventory?: Device["workInventory"];
      inventory: DesktopInventoryItem[];
      inventory_policy_revision: string | null;
      inventory_reported_at: Date | null;
      inventory_sync_error: string | null;
      inventory_sync_status: "synced" | "error" | null;
      last_seen_at: Date | null;
      name: string;
      owner_name: string;
      platform: DesktopPlatform;
      revoked_at: Date | null;
      status: Device["status"];
      user_id: string;
    }>(
      `
        SELECT
          devices.id::text,
          devices.inventory,
          devices.work_inventory,
          devices.inventory_policy_revision::text,
          devices.inventory_reported_at,
          devices.inventory_sync_status,
          devices.inventory_sync_error,
          devices.name,
          devices.platform,
          devices.app_version,
          devices.created_at,
          policies.revision::text AS current_policy_revision,
          devices.last_seen_at,
          devices.revoked_at,
          devices.user_id,
          users.name AS owner_name,
          users.email,
          CASE
            WHEN devices.revoked_at IS NOT NULL THEN 'revoked'
            WHEN EXISTS (
              SELECT 1
              FROM device_sessions sessions
              JOIN device_refresh_tokens refresh
                ON refresh.session_id = sessions.id
              WHERE sessions.device_id = devices.id
                AND sessions.revoked_at IS NULL
                AND refresh.consumed_at IS NULL
                AND refresh.expires_at > NOW()
            ) THEN 'connected'
            ELSE 'expired'
          END AS status
        FROM devices
        JOIN organization_policies policies
          ON policies.organization_id = devices.organization_id
        JOIN "user" users ON users.id = devices.user_id
        WHERE devices.organization_id = $1
          AND ($2::boolean OR devices.user_id = $3)
        ORDER BY devices.created_at DESC
      `,
      [member.organization_id, organizationWide, member.user_id],
    );
    return { devices: result.rows.map(deviceContract) };
  }

  public async listMyDevices(
    headers: IncomingHttpHeaders,
  ): Promise<DevicesResponse> {
    const member = await this.browserMember(headers);
    return this.devices(member, false);
  }

  public async listOrganizationDevices(
    headers: IncomingHttpHeaders,
  ): Promise<DevicesResponse> {
    const member = await this.admin(headers);
    return this.devices(member, true);
  }

  public async revokeDevice(
    headers: IncomingHttpHeaders,
    deviceId: string,
    organizationWide: boolean,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const member = organizationWide
        ? await this.admin(headers, client)
        : await this.browserMember(headers, client);
      const policy = await client.query(
        `
          SELECT 1
          FROM organization_policies
          WHERE organization_id = $1
          FOR UPDATE
        `,
        [member.organization_id],
      );
      if (!policy.rowCount) {
        throw new IdentityError(
          503,
          "policy_unavailable",
          "Organization policy is unavailable.",
        );
      }
      if (organizationWide) {
        await this.revalidateBrowserMember(headers, member, client, true);
      } else {
        await this.revalidateBrowserMember(headers, member, client, false);
      }
      const result = await client.query<{ user_id: string }>(
        `
          UPDATE devices
          SET
            revoked_at = COALESCE(revoked_at, NOW()),
            revoked_by_user_id = $4,
            revoked_reason = COALESCE(revoked_reason, $5),
            updated_at = NOW()
          WHERE id = $1
            AND organization_id = $2
            AND ($3::boolean OR user_id = $4)
          RETURNING user_id
        `,
        [
          deviceId,
          member.organization_id,
          organizationWide,
          member.user_id,
          organizationWide ? "admin_revoked" : "member_revoked",
        ],
      );
      if (!result.rowCount) {
        throw new IdentityError(404, "device_not_found", "Device not found.");
      }
      const revoked = await client.query(
        `
          UPDATE device_sessions
          SET revoked_at = COALESCE(revoked_at, NOW()), revoked_reason = $2
          WHERE device_id = $1 AND revoked_at IS NULL
          RETURNING id
        `,
        [deviceId, organizationWide ? "admin_revoked" : "member_revoked"],
      );
      await recordAuditEvent(client, {
        action: "device.revoked",
        actorUserId: member.user_id,
        organizationId: member.organization_id,
        metadata: {
          revokedSessions: revoked.rowCount ?? 0,
          scope: organizationWide ? "admin" : "self",
        },
        subjectId: deviceId,
        subjectType: "device",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
