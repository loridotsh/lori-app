import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditEventsResponse,
  CreateWorkspaceInput,
  InvitationRole,
  InviteCreated,
  JoinPreview,
  LeaveWorkspaceResult,
  OwnershipTransferResult,
  PendingInvitation,
  PeopleResponse,
  Person,
  Role,
  SetupStatus,
  Viewer,
  WorkspacesResponse,
} from "@lori-enterprise/contracts";
import {
  isOrganizationAdministrator,
  organizationCapabilities,
} from "@lori-enterprise/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import { auditEventsCsv, recordAuditEvent } from "./audit.js";
import {
  activeOrganizationSql,
  assertInvitationAllowed,
  assertMembershipChange,
  assertOwner,
  ownerRequired,
  parseOrganizationRole,
} from "./authority.js";
import { IdentityError } from "./errors.js";

export interface AuditListOptions {
  action: string;
  limit: number;
  offset: number;
  query: string;
}
import {
  generateToken,
  hashToken,
  normalizeEmail,
  ONBOARDING_COOKIE,
  readCookie,
  safeTokenMatches,
  signOnboardingClaim,
  verifyOnboardingClaim,
} from "./onboarding.js";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Ownership transfer requires a sign-in this recent. */
export const OWNERSHIP_TRANSFER_FRESHNESS_MS = 15 * 60 * 1000;
const MAX_ORGANIZATION_MEMBERS = 2_500;
const MAX_PENDING_INVITATIONS = 2_500;
/** Enterprises one person may own on the hosted cloud. */
const MAX_OWNED_ENTERPRISES = 5;
const PERSONAL_WORKSPACE_NAME = "Personal";

interface SessionIdentity {
  session: {
    activeOrganizationId?: string | null;
    createdAt: Date;
    id: string;
    userId: string;
  };
  user: {
    email: string;
    id: string;
    name: string;
  };
}

interface SetupRow {
  admin_user_id: string | null;
  completed_at: Date | null;
  organization_id: string | null;
}

interface ViewerRow {
  email: string;
  member_id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  owner_assigned: boolean;
  personal_workspace: boolean;
  revision: string | null;
  role: string;
  team_admin: boolean;
  usage_member_visibility: boolean;
  user_id: string;
}

interface JoinRow {
  email: string;
  expires_at: Date;
  invitation_expires_at: Date;
  invitation_id: string;
  invitation_status: string;
  inviter_name: string;
  link_id: string;
  organization_id: string;
  organization_name: string;
  role: InvitationRole;
  consumed_at: Date | null;
  revoked_at: Date | null;
  inviter_id: string;
}

export { IdentityError };

const workspaceChanged = () =>
  new IdentityError(
    409,
    "workspace_changed",
    "Your workspace changed in another tab. Reload and try again.",
  );

/**
 * The organization can never lose its last administrator: the Owner is an
 * administrator that cannot be demoted or removed, and when no Owner exists
 * the remaining administrators are protected by count.
 */
export function assertAdminContinuity(
  currentRole: Role,
  adminCount: number,
  action: "demoted" | "removed",
): void {
  if (currentRole === "owner") {
    throw new IdentityError(
      409,
      "owner_protected",
      `The owner cannot be ${action}. Transfer ownership first.`,
    );
  }
  if (currentRole === "admin" && adminCount <= 1) {
    throw new IdentityError(
      409,
      "last_admin",
      `The final administrator cannot be ${action}.`,
    );
  }
}

const requireRole = parseOrganizationRole;

function invitationState(row: JoinRow): JoinPreview["state"] {
  if (row.invitation_status === "accepted" || row.consumed_at) {
    return "used";
  }
  if (row.invitation_status !== "pending" || row.revoked_at) {
    return "revoked";
  }
  if (
    row.expires_at.getTime() <= Date.now() ||
    row.invitation_expires_at.getTime() <= Date.now()
  ) {
    return "expired";
  }
  return "pending";
}

function invitationContract(row: {
  created_at: Date;
  email: string;
  expires_at: Date;
  id: string;
  invited_by_name: string;
  /** The inviter's current role; an admin invitation lapses when it is not Owner. */
  inviter_role?: string | null;
  role: InvitationRole;
  status: string;
  consumed_at: Date | null;
  revoked_at: Date | null;
}): PendingInvitation {
  const lapsed =
    row.role === "admin" &&
    row.inviter_role !== undefined &&
    row.inviter_role !== "owner";
  const state =
    row.status === "accepted" || row.consumed_at
      ? "accepted"
      : row.status !== "pending" || row.revoked_at || lapsed
        ? "revoked"
        : row.expires_at.getTime() <= Date.now()
          ? "expired"
          : "pending";

  return {
    createdAt: row.created_at.toISOString(),
    email: row.email,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    invitedByName: row.invited_by_name,
    role: row.role,
    state,
  };
}

export class IdentityService {
  public constructor(
    private readonly pool: Pool,
    private readonly auth: LoriAuth,
    private readonly config: AppConfig,
  ) {}

  public async enforceRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const now = Date.now();
    const windowMs = windowSeconds * 1_000;
    const result = await this.pool.query<{
      count: number;
      lastRequest: number | string;
    }>(
      `
        INSERT INTO "rateLimit" (id, key, count, "lastRequest")
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (key) DO UPDATE
        SET
          count = CASE
            WHEN $3 - "rateLimit"."lastRequest" >= $4 THEN 1
            ELSE "rateLimit".count + 1
          END,
          "lastRequest" = CASE
            WHEN $3 - "rateLimit"."lastRequest" >= $4 THEN $3
            ELSE "rateLimit"."lastRequest"
          END
        RETURNING count, "lastRequest"
      `,
      [randomUUID(), `lori:${key}`, now, windowMs],
    );
    if ((result.rows[0]?.count ?? limit + 1) > limit) {
      const parsedWindowStartedAt = Number(result.rows[0]?.lastRequest);
      const windowStartedAt = Number.isFinite(parsedWindowStartedAt)
        ? parsedWindowStartedAt
        : now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStartedAt + windowMs - now) / 1_000),
      );
      throw new IdentityError(
        429,
        "rate_limited",
        "Too many requests. Wait before trying again.",
        retryAfterSeconds,
      );
    }
  }

  private async session(
    headers: IncomingHttpHeaders,
  ): Promise<SessionIdentity> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });

    if (!session) {
      throw new IdentityError(401, "unauthenticated", "Sign in is required.");
    }

    return session as SessionIdentity;
  }

  private async viewerForUser(
    userId: string,
    activeOrganizationId: string | null | undefined,
    database: Pool | PoolClient = this.pool,
  ): Promise<Viewer> {
    const result = await database.query<ViewerRow>(
      `
        SELECT
          users.id AS user_id,
          users.name,
          users.email,
          members.id AS member_id,
          members.role,
          EXISTS (
            SELECT 1
            FROM team_member team_memberships
            JOIN team managed_teams ON managed_teams.id = team_memberships.team_id
            WHERE team_memberships.member_id = members.id
              AND team_memberships.role = 'team_admin'
              AND managed_teams.organization_id = organizations.id
          ) AS team_admin,
          organizations.id AS organization_id,
          organizations.name AS organization_name,
          organizations.personal_user_id IS NOT NULL AS personal_workspace,
          policies.revision::text AS revision,
          EXISTS (
            SELECT 1 FROM member owners
            WHERE owners."organizationId" = organizations.id
              AND owners.role = 'owner'
          ) AS owner_assigned,
          COALESCE(
            member_usage.visibility_override,
            policies.usage_member_visibility_default,
            FALSE
          ) AS usage_member_visibility
        FROM "user" users
        JOIN member members ON members."userId" = users.id
        JOIN organization organizations
          ON organizations.id = members."organizationId"
        LEFT JOIN organization_policies policies
          ON policies.organization_id = organizations.id
        LEFT JOIN member_usage_analytics_state member_usage
          ON member_usage.organization_id = organizations.id
         AND member_usage.member_id = members.id
        WHERE users.id = $1
          AND members."organizationId" = ${activeOrganizationSql("$1", "$2")}
        LIMIT 1
      `,
      [userId, activeOrganizationId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        403,
        "membership_required",
        "This account does not belong to the organization.",
      );
    }

    const role = requireRole(row.role);
    const administrator = isOrganizationAdministrator(role);
    return {
      authority: {
        capabilities: organizationCapabilities(role),
        ownerAssigned: row.owner_assigned,
        revision: Number(row.revision ?? 0),
        role,
      },
      ...(this.config.auth.publicSignup ? { cloud: true } : {}),
      organization: {
        id: row.organization_id,
        kind: row.personal_workspace ? "personal" : "enterprise",
        name: row.organization_name,
      },
      role,
      ...(row.team_admin ? { teamAdmin: true } : {}),
      usageAnalytics: {
        canManage: administrator,
        canView: administrator || row.usage_member_visibility,
      },
      user: {
        email: row.email,
        id: row.user_id,
        name: row.name,
      },
    };
  }

  private async admin(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<{ session: SessionIdentity; viewer: Viewer }> {
    const session = await this.session(headers);
    const viewer = await this.viewerForUser(
      session.user.id,
      session.session.activeOrganizationId,
      database,
    );
    if (!isOrganizationAdministrator(viewer.role)) {
      throw new IdentityError(
        403,
        "admin_required",
        "Administrator access is required.",
      );
    }
    return { session, viewer };
  }

  private assertFreshSession(
    session: SessionIdentity,
    freshWithinMs?: number,
    message = "Sign in again before making this change.",
  ): void {
    if (!freshWithinMs) return;
    const now = Date.now();
    const createdAt = new Date(session.session.createdAt).getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt > now + 60_000 ||
      now - createdAt > freshWithinMs
    ) {
      throw new IdentityError(403, "session_not_fresh", message);
    }
  }

  private async adminForMutation(
    headers: IncomingHttpHeaders,
    client: PoolClient,
    freshWithinMs?: number,
  ): Promise<{ session: SessionIdentity; viewer: Viewer }> {
    const initial = await this.admin(headers, client);
    this.assertFreshSession(initial.session, freshWithinMs);
    const policy = await client.query(
      `
        SELECT 1
        FROM organization_policies
        WHERE organization_id = $1
        FOR UPDATE
      `,
      [initial.viewer.organization.id],
    );
    if (!policy.rowCount) {
      throw new IdentityError(
        503,
        "policy_unavailable",
        "Organization policy is unavailable.",
      );
    }

    // The membership can change while this transaction waits for the
    // organization lock. Re-read it after acquiring the lock so a removed or
    // demoted administrator cannot finish a stale privileged mutation.
    const viewer = await this.viewerForUser(
      initial.session.user.id,
      initial.viewer.organization.id,
      client,
    );
    if (
      viewer.organization.id !== initial.viewer.organization.id ||
      !isOrganizationAdministrator(viewer.role)
    ) {
      throw new IdentityError(
        403,
        "admin_required",
        "Administrator access is required.",
      );
    }
    return { session: initial.session, viewer };
  }

  public async requireAdmin(
    headers: IncomingHttpHeaders,
    freshWithinMs?: number,
  ): Promise<Viewer> {
    const { session, viewer } = await this.admin(headers);
    this.assertFreshSession(session, freshWithinMs);
    return viewer;
  }

  public async requireAdminForMutation(
    headers: IncomingHttpHeaders,
    client: PoolClient,
    freshWithinMs?: number,
  ): Promise<Viewer> {
    return (await this.adminForMutation(headers, client, freshWithinMs)).viewer;
  }

  /** Rejects a write prepared against an older organization access revision. */
  private assertRevision(viewer: Viewer, expectedRevision?: number): void {
    if (
      expectedRevision !== undefined &&
      viewer.authority?.revision !== expectedRevision
    ) {
      throw new IdentityError(
        409,
        "access_revision_conflict",
        "Organization access changed. Review the latest roles and try again.",
      );
    }
  }

  /**
   * Locks the target membership and applies the shared authority rules with
   * the actor's role as re-read under the organization lock.
   */
  private async lockedMembershipTarget(
    client: PoolClient,
    viewer: Viewer,
    memberId: string,
    nextRole: InvitationRole | "remove",
  ): Promise<{ role: Role; user_id: string }> {
    const target = await client.query<{ role: string; user_id: string }>(
      `
        SELECT role, "userId" AS user_id
        FROM member
        WHERE id = $1 AND "organizationId" = $2
        FOR UPDATE
      `,
      [memberId, viewer.organization.id],
    );
    const found = target.rows[0];
    if (!found) {
      throw new IdentityError(404, "member_not_found", "Member not found.");
    }
    const row = { role: requireRole(found.role), user_id: found.user_id };
    assertMembershipChange({
      actorRole: viewer.role,
      nextRole,
      self: row.user_id === viewer.user.id,
      targetRole: row.role,
    });
    if (row.role === "admin" && nextRole !== "admin") {
      // Defense in depth for organizations still awaiting an Owner.
      const admins = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count FROM member
          WHERE "organizationId" = $1 AND role IN ('owner', 'admin')
        `,
        [viewer.organization.id],
      );
      assertAdminContinuity(
        row.role,
        Number(admins.rows[0]?.count ?? 0),
        nextRole === "remove" ? "removed" : "demoted",
      );
    }
    return row;
  }

  /**
   * Moves ownership atomically: the target becomes Owner and the current
   * Owner becomes Admin. Requires a recent sign-in and the reviewed revision.
   */
  public async transferOwnership(
    headers: IncomingHttpHeaders,
    memberId: string,
    expectedRevision: number,
  ): Promise<OwnershipTransferResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      assertOwner(viewer.role);
      this.assertFreshSession(
        session,
        OWNERSHIP_TRANSFER_FRESHNESS_MS,
        "Sign in again to transfer ownership. This protects the organization if a session was left open.",
      );
      this.assertRevision(viewer, expectedRevision);
      const members = await client.query<{
        id: string;
        role: string;
        user_id: string;
      }>(
        `
          SELECT id, role, "userId" AS user_id
          FROM member
          WHERE "organizationId" = $1 AND (id = $2 OR "userId" = $3)
          ORDER BY id
          FOR UPDATE
        `,
        [viewer.organization.id, memberId, viewer.user.id],
      );
      const current = members.rows.find((row) => row.user_id === viewer.user.id);
      const target = members.rows.find(
        (row) => row.id === memberId && row.user_id !== viewer.user.id,
      );
      if (!current || current.role !== "owner") throw ownerRequired();
      if (!target) {
        throw new IdentityError(
          members.rows.some((row) => row.id === memberId) ? 409 : 404,
          members.rows.some((row) => row.id === memberId)
            ? "ownership_self_transfer"
            : "member_not_found",
          members.rows.some((row) => row.id === memberId)
            ? "Choose another member to become the owner."
            : "Member not found.",
        );
      }
      const targetRole = requireRole(target.role);
      await this.assertOwnershipCapacity(client, target.user_id);
      // Administrator appointments lapse once their inviter is no longer the
      // Owner; cancel them so the invitation list and the pending-invitation
      // limit stay truthful, and so a later transfer back cannot revive them.
      await client.query(
        `
          WITH canceled AS (
            UPDATE invitation SET status = 'canceled'
            WHERE "organizationId" = $1 AND "inviterId" = $2
              AND status = 'pending' AND role = 'admin'
            RETURNING id
          )
          UPDATE invite_links SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE invitation_id IN (SELECT id FROM canceled) AND consumed_at IS NULL
        `,
        [viewer.organization.id, viewer.user.id],
      );
      // Demote first: a partial unique index allows only one Owner at a time.
      await client.query("UPDATE member SET role = 'admin' WHERE id = $1", [
        current.id,
      ]);
      await client.query("UPDATE member SET role = 'owner' WHERE id = $1", [
        target.id,
      ]);
      const revision = await client.query<{ revision: string }>(
        `
          UPDATE organization_policies
          SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $2
          WHERE organization_id = $1
          RETURNING revision::text
        `,
        [viewer.organization.id, session.user.id],
      );
      await recordAuditEvent(client, {
        action: "organization.ownership_transferred",
        actorUserId: session.user.id,
        organizationId: viewer.organization.id,
        metadata: {
          fromMemberId: current.id,
          toMemberId: target.id,
          toPreviousRole: targetRole,
        },
        subjectId: target.user_id,
        subjectType: "user",
      });
      await client.query("COMMIT");
      return {
        ownerMemberId: target.id,
        previousOwnerMemberId: current.id,
        revision: Number(revision.rows[0]?.revision ?? 0),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async joinRowForToken(
    token: string,
    database: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<JoinRow | null> {
    const result = await database.query<JoinRow>(
      `
        SELECT
          links.id::text AS link_id,
          links.expires_at,
          links.consumed_at,
          links.revoked_at,
          invitations.id AS invitation_id,
          invitations.email,
          invitations.role,
          invitations.status AS invitation_status,
          invitations."expiresAt" AS invitation_expires_at,
          invitations."inviterId" AS inviter_id,
          organizations.id AS organization_id,
          organizations.name AS organization_name,
          inviters.name AS inviter_name
        FROM invite_links links
        JOIN invitation invitations ON invitations.id = links.invitation_id
        JOIN organization organizations
          ON organizations.id = invitations."organizationId"
        JOIN "user" inviters ON inviters.id = invitations."inviterId"
        WHERE links.token_hash = $1
        LIMIT 1
        ${lock ? "FOR UPDATE OF links, invitations" : ""}
      `,
      [hashToken(token)],
    );
    return result.rows[0] ?? null;
  }

  public async setupStatus(): Promise<SetupStatus> {
    const result = await this.pool.query<SetupRow>(
      "SELECT completed_at, organization_id, admin_user_id FROM deployment_setup WHERE singleton = TRUE",
    );
    const publicSignup = this.config.auth.publicSignup === true;
    const state =
      publicSignup || result.rows[0]?.completed_at ? "ready" : "requires_setup";
    const status: SetupStatus = {
      publicUrl: this.config.publicUrl,
      state,
      ...(publicSignup ? { publicSignup } : {}),
    };
    if (state === "requires_setup") {
      status.tokenGuidance = this.buildSetupTokenGuidance();
    }
    return status;
  }

  private buildSetupTokenGuidance(): SetupStatus["tokenGuidance"] {
    if (this.config.environment === "production") {
      return {
        expiresAt: this.config.auth.setupTokenExpiresAt
          ? new Date(this.config.auth.setupTokenExpiresAt).toISOString()
          : undefined,
        source: "docker_compose",
      };
    }
    return {
      developmentToken: this.config.auth.setupToken,
      source: "local_development",
    };
  }

  public async claimSetup(token: string, email: string): Promise<string> {
    const status = await this.setupStatus();
    if (status.state === "ready") {
      throw new IdentityError(
        409,
        "setup_complete",
        "This deployment is already configured.",
      );
    }
    if (
      this.config.auth.setupTokenExpiresAt !== undefined &&
      Date.now() >= this.config.auth.setupTokenExpiresAt
    ) {
      throw new IdentityError(
        403,
        "setup_token_expired",
        "The setup token has expired. Generate a new setup token from the server console.",
      );
    }
    if (!safeTokenMatches(token, this.config.auth.setupToken)) {
      throw new IdentityError(
        403,
        "invalid_setup_token",
        "The setup token is invalid.",
      );
    }

    return signOnboardingClaim(
      {
        email: normalizeEmail(email),
        purpose: "setup",
      },
      this.config.auth.secret,
    );
  }

  public async completeSetup(
    headers: IncomingHttpHeaders,
    cookieHeader: string | undefined,
    organizationName: string,
  ): Promise<Viewer> {
    const session = await this.session(headers);
    const claim = verifyOnboardingClaim(
      readCookie(cookieHeader, ONBOARDING_COOKIE),
      this.config.auth.secret,
    );
    if (
      !claim ||
      claim.purpose !== "setup" ||
      claim.email !== normalizeEmail(session.user.email)
    ) {
      throw new IdentityError(
        403,
        "setup_claim_required",
        "A valid setup claim is required.",
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('lori-enterprise-setup'))",
      );
      const setup = await client.query<SetupRow>(
        `
          SELECT completed_at, organization_id, admin_user_id
          FROM deployment_setup
          WHERE singleton = TRUE
          FOR UPDATE
        `,
      );
      const current = setup.rows[0];
      if (current?.completed_at) {
        if (current.admin_user_id !== session.user.id) {
          throw new IdentityError(
            409,
            "setup_complete",
            "This deployment is already configured.",
          );
        }
        const viewer = await this.viewerForUser(
          session.user.id,
          current.organization_id,
          client,
        );
        await client.query("COMMIT");
        return viewer;
      }

      const organizationId = await this.provisionOrganization(client, {
        name: organizationName.trim(),
        ownerUserId: session.user.id,
        personal: false,
        slug: "organization",
      });
      await client.query(
        `
          UPDATE session
          SET "activeOrganizationId" = $1, "updatedAt" = NOW()
          WHERE "userId" = $2
        `,
        [organizationId, session.user.id],
      );
      await client.query(
        `
          UPDATE deployment_setup
          SET
            completed_at = NOW(),
            organization_id = $1,
            admin_user_id = $2
          WHERE singleton = TRUE
        `,
        [organizationId, session.user.id],
      );
      await recordAuditEvent(client, {
        action: "deployment.setup_completed",
        actorUserId: session.user.id,
        organizationId,
        metadata: { organizationName: organizationName.trim() },
        subjectId: organizationId,
        subjectType: "organization",
      });
      const viewer = await this.viewerForUser(
        session.user.id,
        organizationId,
        client,
      );
      await client.query("COMMIT");
      return viewer;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** The rows every organization needs, with its creator as Owner. */
  private async provisionOrganization(
    client: PoolClient,
    input: {
      name: string;
      ownerUserId: string;
      personal: boolean;
      slug?: string;
    },
  ): Promise<string> {
    const organizationId = randomUUID();
    await client.query(
      `
        INSERT INTO organization (
          id, name, slug, "createdAt", metadata, personal_user_id
        )
        VALUES ($1, $2, $3, NOW(), $4, $5)
      `,
      [
        organizationId,
        input.name,
        input.slug ?? `workspace-${organizationId}`,
        JSON.stringify({}),
        input.personal ? input.ownerUserId : null,
      ],
    );
    await client.query(
      `
        INSERT INTO organization_policies (
          organization_id,
          updated_by_user_id,
          allow_personal_plugins,
          allow_personal_providers,
          allow_personal_skills
        )
        VALUES ($1, $2, $3, $3, $3)
      `,
      // An individual answers to nobody, so their own installs start allowed.
      [organizationId, input.ownerUserId, input.personal],
    );
    await client.query(
      "INSERT INTO organization_work_policies(organization_id) VALUES ($1)",
      [organizationId],
    );
    await client.query(
      `
        INSERT INTO member (
          id,
          "organizationId",
          "userId",
          role,
          "createdAt"
        )
        VALUES ($1, $2, $3, 'owner', NOW())
      `,
      [randomUUID(), organizationId, input.ownerUserId],
    );
    return organizationId;
  }

  /** Self-hosted deployments have no such limit: their organizations are operator-run. */
  private async assertOwnershipCapacity(
    client: PoolClient,
    userId: string,
  ): Promise<void> {
    if (!this.config.auth.publicSignup) return;
    const owned = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM member members
        JOIN organization organizations
          ON organizations.id = members."organizationId"
        WHERE members."userId" = $1
          AND members.role = 'owner'
          AND organizations.personal_user_id IS NULL
      `,
      [userId],
    );
    if (Number(owned.rows[0]?.count ?? 0) >= MAX_OWNED_ENTERPRISES) {
      throw new IdentityError(
        409,
        "organization_limit",
        `An account can own up to ${MAX_OWNED_ENTERPRISES} organizations.`,
      );
    }
  }

  /** An expired invitation is finished: it must not block a new one or use up the limit. */
  private async closeExpiredInvitations(
    client: PoolClient,
    organizationId: string,
    email: string,
  ): Promise<void> {
    await client.query(
      `
        WITH lapsed AS (
          UPDATE invitation SET status = 'canceled'
          WHERE "organizationId" = $1 AND email = $2
            AND status = 'pending' AND "expiresAt" <= NOW()
          RETURNING id
        )
        UPDATE invite_links SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE invitation_id IN (SELECT id FROM lapsed) AND consumed_at IS NULL
      `,
      [organizationId, email],
    );
  }

  public async listWorkspaces(
    headers: IncomingHttpHeaders,
  ): Promise<WorkspacesResponse> {
    const session = await this.session(headers);
    const result = await this.pool.query<{
      active: boolean;
      id: string;
      name: string;
      personal: boolean;
      role: string;
    }>(
      `
        SELECT
          organizations.id,
          organizations.name,
          organizations.personal_user_id IS NOT NULL AS personal,
          members.role,
          organizations.id = ${activeOrganizationSql("$1", "$2")} AS active
        FROM member members
        JOIN organization organizations
          ON organizations.id = members."organizationId"
        WHERE members."userId" = $1
        ORDER BY personal DESC, organizations.name ASC, organizations.id ASC
      `,
      [session.user.id, session.session.activeOrganizationId ?? null],
    );
    const canCreate = this.config.auth.publicSignup === true;
    const personal = await this.pool.query(
      "SELECT 1 FROM organization WHERE personal_user_id = $1",
      [session.user.id],
    );
    return {
      canCreate,
      canCreatePersonal: canCreate && !personal.rowCount,
      workspaces: result.rows.map((row) => ({
        active: row.active,
        id: row.id,
        kind: row.personal ? "personal" : "enterprise",
        name: row.name,
        role: requireRole(row.role),
      })),
    };
  }

  public async createWorkspace(
    headers: IncomingHttpHeaders,
    input: CreateWorkspaceInput,
  ): Promise<Viewer> {
    if (!this.config.auth.publicSignup) {
      throw new IdentityError(
        403,
        "public_signup_disabled",
        "This deployment does not allow creating new workspaces.",
      );
    }
    const session = await this.session(headers);
    const personal = input.kind === "personal";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One creation per person at a time, so a double submit cannot pass the
      // checks below twice.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `lori-workspace:${session.user.id}`,
      ]);
      if (personal) {
        const existing = await client.query(
          "SELECT 1 FROM organization WHERE personal_user_id = $1",
          [session.user.id],
        );
        if (existing.rowCount) {
          throw new IdentityError(
            409,
            "personal_workspace_exists",
            "This account already has a personal workspace.",
          );
        }
      } else {
        await this.assertOwnershipCapacity(client, session.user.id);
      }

      const name =
        input.kind === "enterprise"
          ? input.organizationName.trim()
          : PERSONAL_WORKSPACE_NAME;
      const organizationId = await this.provisionOrganization(client, {
        name,
        ownerUserId: session.user.id,
        personal,
      });
      await client.query(
        `
          UPDATE session
          SET "activeOrganizationId" = $1, "updatedAt" = NOW()
          WHERE id = $2
        `,
        [organizationId, session.session.id],
      );
      await recordAuditEvent(client, {
        action: "organization.created",
        actorUserId: session.user.id,
        organizationId,
        metadata: { kind: input.kind, organizationName: name },
        subjectId: organizationId,
        subjectType: "organization",
      });
      const viewer = await this.viewerForUser(
        session.user.id,
        organizationId,
        client,
      );
      await client.query("COMMIT");
      return viewer;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Moves this browser session only; other sessions and desktops stay put. */
  public async switchWorkspace(
    headers: IncomingHttpHeaders,
    organizationId: string,
  ): Promise<Viewer> {
    const session = await this.session(headers);
    const updated = await this.pool.query(
      `
        UPDATE session
        SET "activeOrganizationId" = $1, "updatedAt" = NOW()
        WHERE id = $2
          AND EXISTS (
            SELECT 1 FROM member
            WHERE "organizationId" = $1 AND "userId" = $3
          )
      `,
      [organizationId, session.session.id, session.user.id],
    );
    if (!updated.rowCount) {
      throw new IdentityError(
        404,
        "workspace_not_found",
        "This workspace is not available to your account.",
      );
    }
    return this.viewerForUser(session.user.id, organizationId);
  }

  /** Cloud admissions bind browser work to the durable session, not a device identity. */
  public async getCloudIdentity(headers: IncomingHttpHeaders): Promise<{viewer:Viewer;sessionId:string}> {
    const session=await this.session(headers);
    return {viewer:await this.viewerForUser(session.user.id,session.session.activeOrganizationId),sessionId:session.session.id};
  }

  public async getViewer(headers: IncomingHttpHeaders): Promise<Viewer> {
    const session = await this.session(headers);
    return this.viewerForUser(session.user.id, session.session.activeOrganizationId);
  }

  /**
   * An administrator appointment is honored only while the person who made it
   * is still the Owner. Member invitations stay valid as issued.
   */
  private async invitationAuthorityValid(
    row: JoinRow,
    database: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<boolean> {
    if (row.role !== "admin") return true;
    const inviter = await database.query<{ role: string }>(
      `
        SELECT role FROM member
        WHERE "organizationId" = $1 AND "userId" = $2
        ${lock ? "FOR SHARE" : ""}
      `,
      [row.organization_id, row.inviter_id],
    );
    return inviter.rows[0]?.role === "owner";
  }

  public async previewJoin(token: string): Promise<JoinPreview> {
    const row = await this.joinRowForToken(token);
    if (!row) {
      return { state: "invalid" };
    }
    const state = invitationState(row);
    if (state !== "pending") {
      return { state };
    }
    if (!(await this.invitationAuthorityValid(row))) {
      return { state: "revoked" };
    }
    return {
      email: row.email,
      expiresAt: row.expires_at.toISOString(),
      inviterName: row.inviter_name,
      organizationName: row.organization_name,
      role: row.role,
      state,
    };
  }

  public async claimJoin(token: string): Promise<string> {
    const row = await this.joinRowForToken(token);
    if (
      !row ||
      invitationState(row) !== "pending" ||
      !(await this.invitationAuthorityValid(row))
    ) {
      throw new IdentityError(
        410,
        "invitation_unavailable",
        "This invitation is invalid, expired, revoked, or already used.",
      );
    }
    return signOnboardingClaim(
      {
        email: row.email,
        invitationLinkId: row.link_id,
        purpose: "invitation",
      },
      this.config.auth.secret,
    );
  }

  public async acceptJoin(
    token: string,
    headers: IncomingHttpHeaders,
    cookieHeader: string | undefined,
  ): Promise<Viewer> {
    const session = await this.session(headers);
    const claim = verifyOnboardingClaim(
      readCookie(cookieHeader, ONBOARDING_COOKIE),
      this.config.auth.secret,
    );
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const preliminary = await this.joinRowForToken(token, client);
      if (!preliminary) {
        throw new IdentityError(
          404,
          "invalid_invitation",
          "Invitation not found.",
        );
      }
      const policy = await client.query(
        `
          SELECT 1
          FROM organization_policies
          WHERE organization_id = $1
          FOR UPDATE
        `,
        [preliminary.organization_id],
      );
      if (!policy.rowCount) {
        throw new IdentityError(
          503,
          "policy_unavailable",
          "Organization policy is unavailable.",
        );
      }
      const row = await this.joinRowForToken(token, client, true);
      if (!row) {
        throw new IdentityError(
          404,
          "invalid_invitation",
          "Invitation not found.",
        );
      }
      if (
        !claim ||
        claim.purpose !== "invitation" ||
        claim.invitationLinkId !== row.link_id
      ) {
        throw new IdentityError(
          403,
          "invitation_claim_required",
          "Claim this invitation before accepting it.",
        );
      }
      if (normalizeEmail(session.user.email) !== normalizeEmail(row.email)) {
        throw new IdentityError(
          403,
          "wrong_email",
          `Sign in with ${row.email} to accept this invitation.`,
        );
      }

      const state = invitationState(row);
      const existing = await client.query(
        `
          SELECT 1 FROM member
          WHERE "organizationId" = $1 AND "userId" = $2
        `,
        [row.organization_id, session.user.id],
      );
      if (state === "used" && existing.rowCount === 1) {
        await client.query("COMMIT");
        return this.viewerForUser(session.user.id, row.organization_id);
      }
      if (state !== "pending") {
        throw new IdentityError(
          410,
          `invitation_${state}`,
          "This invitation is no longer available.",
        );
      }
      if (!(await this.invitationAuthorityValid(row, client, true))) {
        throw new IdentityError(
          410,
          "invitation_revoked",
          "This administrator invitation is no longer valid. Ask the organization owner for a new one.",
        );
      }

      if (existing.rowCount === 0) {
        const membershipCount = await client.query<{ count: string }>(
          `
            SELECT COUNT(*)::text AS count
            FROM member
            WHERE "organizationId" = $1
          `,
          [row.organization_id],
        );
        if (
          Number(membershipCount.rows[0]?.count ?? 0) >=
          MAX_ORGANIZATION_MEMBERS
        ) {
          throw new IdentityError(
            409,
            "membership_limit",
            "This organization has reached its member limit.",
          );
        }
        await client.query(
          `
            INSERT INTO member (
              id,
              "organizationId",
              "userId",
              role,
              "createdAt"
            )
            VALUES ($1, $2, $3, $4, NOW())
          `,
          [randomUUID(), row.organization_id, session.user.id, row.role],
        );
      }
      await client.query(
        `UPDATE invitation SET status = 'accepted' WHERE id = $1`,
        [row.invitation_id],
      );
      await client.query(
        `UPDATE invite_links SET consumed_at = NOW() WHERE id = $1`,
        [row.link_id],
      );
      await client.query(
        `
          UPDATE session
          SET "activeOrganizationId" = $1, "updatedAt" = NOW()
          WHERE id = $2
        `,
        [row.organization_id, session.session.id],
      );
      await recordAuditEvent(client, {
        action: "invitation.accepted",
        actorUserId: session.user.id,
        organizationId: row.organization_id,
        metadata: { role: row.role },
        subjectId: row.invitation_id,
        subjectType: "invitation",
      });
      await client.query("COMMIT");
      return this.viewerForUser(session.user.id, row.organization_id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listPeople(
    headers: IncomingHttpHeaders,
  ): Promise<PeopleResponse> {
    const { viewer } = await this.admin(headers);
    const [members, invitations] = await Promise.all([
      this.pool.query<{
        created_at: Date;
        email: string;
        member_id: string;
        name: string;
        role: string;
        user_id: string;
      }>(
        `
          SELECT
            members.id AS member_id,
            members."userId" AS user_id,
            users.name,
            users.email,
            members.role,
            members."createdAt" AS created_at
          FROM member members
          JOIN "user" users ON users.id = members."userId"
          WHERE members."organizationId" = $1
          ORDER BY users.name, users.email
        `,
        [viewer.organization.id],
      ),
      this.pool.query<{
        consumed_at: Date | null;
        created_at: Date;
        email: string;
        expires_at: Date;
        id: string;
        invited_by_name: string;
        inviter_role: string | null;
        revoked_at: Date | null;
        role: InvitationRole;
        status: string;
      }>(
        `
          SELECT
            invitations.id,
            invitations.email,
            invitations.role,
            invitations.status,
            invitations."createdAt" AS created_at,
            invitations."expiresAt" AS expires_at,
            inviters.name AS invited_by_name,
            inviter_members.role AS inviter_role,
            links.consumed_at,
            links.revoked_at
          FROM invitation invitations
          JOIN "user" inviters ON inviters.id = invitations."inviterId"
          LEFT JOIN member inviter_members
            ON inviter_members."userId" = invitations."inviterId"
           AND inviter_members."organizationId" = invitations."organizationId"
          LEFT JOIN LATERAL (
            SELECT consumed_at, revoked_at
            FROM invite_links
            WHERE invitation_id = invitations.id
            ORDER BY created_at DESC
            LIMIT 1
          ) links ON TRUE
          WHERE invitations."organizationId" = $1
            AND invitations.status <> 'accepted'
          ORDER BY invitations."createdAt" DESC
        `,
        [viewer.organization.id],
      ),
    ]);

    return {
      invitations: invitations.rows.map(invitationContract),
      revision: viewer.authority?.revision,
      members: members.rows.map((row): Person => ({
        createdAt: row.created_at.toISOString(),
        email: row.email,
        memberId: row.member_id,
        name: row.name,
        role: requireRole(row.role),
        userId: row.user_id,
      })),
    };
  }

  public async listAuditEvents(
    headers: IncomingHttpHeaders,
    options: AuditListOptions,
  ): Promise<AuditEventsResponse> {
    const { viewer } = await this.admin(headers);
    const result = await this.pool.query<{
      action: string;
      actor_email: string | null;
      actor_name: string | null;
      actor_user_id: string | null;
      created_at: Date;
      id: string;
      metadata: Record<string, unknown>;
      subject_id: string | null;
      subject_type: string | null;
      total_count: string;
    }>(
      `
        SELECT
          events.id::text,
          events.action,
          events.actor_user_id,
          actors.name AS actor_name,
          actors.email AS actor_email,
          events.subject_type,
          events.subject_id,
          events.metadata,
          events.created_at,
          COUNT(*) OVER()::text AS total_count
        FROM audit_events events
        LEFT JOIN "user" actors ON actors.id = events.actor_user_id
        WHERE events.organization_id = $1
          AND ($2 = '' OR events.action = $2)
          AND (
            $3 = ''
            OR events.action ILIKE '%' || $3 || '%'
            OR COALESCE(actors.name, '') ILIKE '%' || $3 || '%'
            OR COALESCE(actors.email, '') ILIKE '%' || $3 || '%'
            OR COALESCE(events.subject_type, '') ILIKE '%' || $3 || '%'
            OR COALESCE(events.subject_id, '') ILIKE '%' || $3 || '%'
          )
        ORDER BY events.created_at DESC, events.id DESC
        LIMIT $4 OFFSET $5
      `,
      [
        viewer.organization.id,
        options.action,
        options.query,
        options.limit,
        options.offset,
      ],
    );
    const events: AuditEvent[] = result.rows.map((row) => ({
      action: row.action,
      ...(row.actor_user_id && row.actor_name && row.actor_email
        ? {
            actor: {
              email: row.actor_email,
              id: row.actor_user_id,
              name: row.actor_name,
            },
          }
        : {}),
      createdAt: row.created_at.toISOString(),
      id: row.id,
      metadata: row.metadata,
      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
      ...(row.subject_type ? { subjectType: row.subject_type } : {}),
    }));
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      events,
      pageInfo: {
        hasMore: options.offset + events.length < total,
        limit: options.limit,
        offset: options.offset,
        total,
      },
    };
  }

  public async exportAuditEvents(
    headers: IncomingHttpHeaders,
    options: Omit<AuditListOptions, "limit" | "offset">,
  ): Promise<string> {
    const batch = await this.listAuditEvents(headers, {
      ...options,
      limit: 5_000,
      offset: 0,
    });
    return auditEventsCsv(batch.events);
  }

  private async createLink(
    database: PoolClient,
    invitationId: string,
    expiresAt: Date,
  ): Promise<{ linkId: string; token: string }> {
    const token = generateToken();
    const linkId = randomUUID();
    await database.query(
      `
        INSERT INTO invite_links (
          id,
          invitation_id,
          token_hash,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
      `,
      [linkId, invitationId, hashToken(token), expiresAt],
    );
    return { linkId, token };
  }

  public async createInvitation(
    headers: IncomingHttpHeaders,
    emailInput: string,
    role: InvitationRole,
  ): Promise<InviteCreated> {
    const email = normalizeEmail(emailInput);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      assertInvitationAllowed(viewer.role, role);
      if (viewer.organization.kind === "personal") {
        throw new IdentityError(
          409,
          "personal_workspace",
          "A personal workspace is just for you. Create an organization to invite people.",
        );
      }
      const member = await client.query(
        `
          SELECT 1
          FROM member
          JOIN "user" users ON users.id = member."userId"
          WHERE member."organizationId" = $1 AND users.email = $2
          LIMIT 1
        `,
        [viewer.organization.id, email],
      );
      if (member.rowCount) {
        throw new IdentityError(
          409,
          "already_member",
          "This email already belongs to a member.",
        );
      }
      await this.closeExpiredInvitations(client, viewer.organization.id, email);
      const pending = await client.query(
        `
          SELECT 1 FROM invitation
          WHERE "organizationId" = $1 AND email = $2 AND status = 'pending'
          LIMIT 1
        `,
        [viewer.organization.id, email],
      );
      if (pending.rowCount) {
        throw new IdentityError(
          409,
          "invitation_exists",
          "A pending invitation already exists for this email.",
        );
      }
      const pendingCount = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM invitation
          WHERE "organizationId" = $1 AND status = 'pending'
            AND "expiresAt" > NOW()
        `,
        [viewer.organization.id],
      );
      if (Number(pendingCount.rows[0]?.count ?? 0) >= MAX_PENDING_INVITATIONS) {
        throw new IdentityError(
          409,
          "invitation_limit",
          "This organization has reached its pending invitation limit.",
        );
      }

      const invitationId = randomUUID();
      const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
      await client.query(
        `
          INSERT INTO invitation (
            id,
            "organizationId",
            email,
            role,
            status,
            "expiresAt",
            "createdAt",
            "inviterId"
          )
          VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), $6)
        `,
        [
          invitationId,
          viewer.organization.id,
          email,
          role,
          expiresAt,
          session.user.id,
        ],
      );
      const { token } = await this.createLink(client, invitationId, expiresAt);
      await recordAuditEvent(client, {
        action: "invitation.created",
        actorUserId: session.user.id,
        organizationId: viewer.organization.id,
        metadata: { email, role },
        subjectId: invitationId,
        subjectType: "invitation",
      });
      const created = await client.query<{
        consumed_at: Date | null;
        created_at: Date;
        email: string;
        expires_at: Date;
        id: string;
        invited_by_name: string;
        revoked_at: Date | null;
        role: InvitationRole;
        status: string;
      }>(
        `
          SELECT
            invitations.id,
            invitations.email,
            invitations.role,
            invitations.status,
            invitations."createdAt" AS created_at,
            invitations."expiresAt" AS expires_at,
            users.name AS invited_by_name,
            NULL::timestamptz AS consumed_at,
            NULL::timestamptz AS revoked_at
          FROM invitation invitations
          JOIN "user" users ON users.id = invitations."inviterId"
          WHERE invitations.id = $1
        `,
        [invitationId],
      );
      await client.query("COMMIT");
      return {
        invitation: invitationContract(created.rows[0]!),
        url: `${this.config.publicUrl}/join/${token}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async regenerateInvitation(
    headers: IncomingHttpHeaders,
    invitationId: string,
  ): Promise<InviteCreated> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      const invitation = await client.query<{
        created_at: Date;
        email: string;
        id: string;
        role: InvitationRole;
      }>(
        `
          SELECT
            invitations.id,
            invitations.email,
            invitations.role,
            invitations."createdAt" AS created_at
          FROM invitation invitations
          WHERE invitations.id = $1
            AND invitations."organizationId" = $2
            AND invitations.status <> 'accepted'
          FOR UPDATE OF invitations
        `,
        [invitationId, viewer.organization.id],
      );
      const found = invitation.rows[0];
      if (!found) {
        throw new IdentityError(
          404,
          "invitation_not_found",
          "Invitation not found.",
        );
      }
      // A new link is a new appointment, issued with the actor's own authority.
      assertInvitationAllowed(viewer.role, found.role);
      const row = { ...found, invited_by_name: viewer.user.name };
      await client.query(
        `
          UPDATE invitation SET status = 'canceled'
          WHERE "organizationId" = $1 AND email = $2 AND id <> $3
            AND status = 'pending' AND "expiresAt" <= NOW()
        `,
        [viewer.organization.id, found.email, invitationId],
      );
      const live = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM invitation
          WHERE "organizationId" = $1 AND status = 'pending'
            AND "expiresAt" > NOW() AND id <> $2
        `,
        [viewer.organization.id, invitationId],
      );
      if (Number(live.rows[0]?.count ?? 0) >= MAX_PENDING_INVITATIONS) {
        throw new IdentityError(
          409,
          "invitation_limit",
          "This organization has reached its pending invitation limit.",
        );
      }
      const conflicts = await client.query<{ kind: string }>(
        `
          SELECT 'member' AS kind
          FROM member
          JOIN "user" users ON users.id = member."userId"
          WHERE member."organizationId" = $1 AND users.email = $2
          UNION ALL
          SELECT 'invitation' AS kind
          FROM invitation
          WHERE "organizationId" = $1 AND email = $2
            AND status = 'pending' AND id <> $3
          LIMIT 1
        `,
        [viewer.organization.id, found.email, invitationId],
      );
      if (conflicts.rows[0]?.kind === "member") {
        throw new IdentityError(
          409,
          "already_member",
          "This email already belongs to a member.",
        );
      }
      if (conflicts.rows[0]?.kind === "invitation") {
        throw new IdentityError(
          409,
          "invitation_exists",
          "A newer pending invitation already exists for this email.",
        );
      }
      const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
      await client.query(
        `
          UPDATE invite_links
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE invitation_id = $1 AND consumed_at IS NULL
        `,
        [invitationId],
      );
      await client.query(
        `
          UPDATE invitation
          SET status = 'pending', "expiresAt" = $2, "inviterId" = $3
          WHERE id = $1
        `,
        [invitationId, expiresAt, session.user.id],
      );
      const { token } = await this.createLink(client, invitationId, expiresAt);
      await recordAuditEvent(client, {
        action: "invitation.regenerated",
        actorUserId: session.user.id,
        organizationId: viewer.organization.id,
        subjectId: invitationId,
        subjectType: "invitation",
      });
      await client.query("COMMIT");
      return {
        invitation: invitationContract({
          ...row,
          consumed_at: null,
          expires_at: expiresAt,
          revoked_at: null,
          status: "pending",
        }),
        url: `${this.config.publicUrl}/join/${token}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeInvitation(
    headers: IncomingHttpHeaders,
    invitationId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      const pending = await client.query<{ role: InvitationRole }>(
        `
          SELECT role FROM invitation
          WHERE id = $1
            AND "organizationId" = $2
            AND status = 'pending'
          FOR UPDATE
        `,
        [invitationId, viewer.organization.id],
      );
      if (!pending.rows[0]) {
        throw new IdentityError(
          404,
          "invitation_not_found",
          "Pending invitation not found.",
        );
      }
      // Withdrawing an administrator appointment is itself an owner decision.
      assertInvitationAllowed(viewer.role, pending.rows[0].role);
      await client.query(
        `UPDATE invitation SET status = 'canceled' WHERE id = $1`,
        [invitationId],
      );
      await client.query(
        `
          UPDATE invite_links
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE invitation_id = $1 AND consumed_at IS NULL
        `,
        [invitationId],
      );
      await recordAuditEvent(client, {
        action: "invitation.revoked",
        actorUserId: session.user.id,
        organizationId: viewer.organization.id,
        subjectId: invitationId,
        subjectType: "invitation",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateMemberRole(
    headers: IncomingHttpHeaders,
    memberId: string,
    role: InvitationRole,
    expectedRevision?: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      this.assertRevision(viewer, expectedRevision);
      const row = await this.lockedMembershipTarget(
        client,
        viewer,
        memberId,
        role,
      );
      if (row.role !== role) {
        await client.query("UPDATE member SET role = $2 WHERE id = $1", [
          memberId,
          role,
        ]);
        await client.query(
          `
            UPDATE organization_policies
            SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $2
            WHERE organization_id = $1
          `,
          [viewer.organization.id, session.user.id],
        );
        await recordAuditEvent(client, {
          action: "member.role_changed",
          actorUserId: session.user.id,
          organizationId: viewer.organization.id,
          metadata: { from: row.role, to: role },
          subjectId: row.user_id,
          subjectType: "user",
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async removeMember(
    headers: IncomingHttpHeaders,
    memberId: string,
    expectedRevision?: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { session, viewer } = await this.adminForMutation(headers, client);
      this.assertRevision(viewer, expectedRevision);
      const row = await this.lockedMembershipTarget(
        client,
        viewer,
        memberId,
        "remove",
      );
      await this.endMembership(client, {
        action: "member.removed",
        actorUserId: session.user.id,
        memberId,
        organizationId: viewer.organization.id,
        userId: row.user_id,
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
   * Leaves the workspace the caller's page was showing. The organization is
   * named by the caller so a tab left open on another workspace cannot leave
   * the wrong one. The Owner must transfer ownership first.
   */
  public async leaveWorkspace(
    headers: IncomingHttpHeaders,
    organizationId: string,
  ): Promise<LeaveWorkspaceResult> {
    // Self-hosted membership is managed by the organization's administrators.
    if (!this.config.auth.publicSignup) {
      throw new IdentityError(
        403,
        "public_signup_disabled",
        "Ask an administrator to remove you from this organization.",
      );
    }
    const session = await this.session(headers);
    const client = await this.pool.connect();
    const current = () =>
      this.viewerForUser(
        session.user.id,
        session.session.activeOrganizationId,
        client,
      );
    try {
      await client.query("BEGIN");
      if ((await current()).organization.id !== organizationId) {
        throw workspaceChanged();
      }
      await client.query(
        "SELECT 1 FROM organization_policies WHERE organization_id = $1 FOR UPDATE",
        [organizationId],
      );
      const viewer = await current();
      if (viewer.organization.id !== organizationId) throw workspaceChanged();
      if (viewer.organization.kind === "personal") {
        throw new IdentityError(
          409,
          "personal_workspace",
          "Your personal workspace cannot be left.",
        );
      }
      if (viewer.role === "owner") {
        throw new IdentityError(
          409,
          "owner_cannot_leave",
          "Transfer ownership to another member before leaving.",
        );
      }
      const member = await client.query<{ id: string }>(
        `
          SELECT id FROM member
          WHERE "organizationId" = $1 AND "userId" = $2
          FOR UPDATE
        `,
        [organizationId, session.user.id],
      );
      await this.endMembership(client, {
        action: "member.left",
        actorUserId: session.user.id,
        memberId: member.rows[0]!.id,
        organizationId,
        userId: session.user.id,
      });
      const next = await client.query<{ organization_id: string | null }>(
        `SELECT ${activeOrganizationSql("$1", "NULL")} AS organization_id`,
        [session.user.id],
      );
      const organization = next.rows[0]?.organization_id
        ? (await this.viewerForUser(session.user.id, next.rows[0].organization_id, client)).organization
        : null;
      await client.query("COMMIT");
      return { organization };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Everything that ends with a membership, for removal and leaving alike.
   * Runs inside the caller's transaction, which holds the organization lock.
   */
  private async endMembership(
    client: PoolClient,
    {
      action,
      actorUserId,
      memberId,
      organizationId,
      userId,
    }: {
      action: "member.left" | "member.removed";
      actorUserId: string;
      memberId: string;
      organizationId: string;
      userId: string;
    },
  ): Promise<void> {
    // Invitations this person issued end with them: otherwise someone removed
    // for cause could keep a live way back in.
    await client.query(
      `
        WITH canceled AS (
          UPDATE invitation SET status = 'canceled'
          WHERE "organizationId" = $1 AND "inviterId" = $2
            AND status = 'pending'
          RETURNING id
        )
        UPDATE invite_links SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE invitation_id IN (SELECT id FROM canceled) AND consumed_at IS NULL
      `,
      [organizationId, userId],
    );
    const revokedDeviceSessions = await client.query(
      `
        UPDATE device_sessions sessions
        SET
          revoked_at = COALESCE(sessions.revoked_at, NOW()),
          revoked_reason = COALESCE(sessions.revoked_reason, 'membership_removed')
        FROM devices
        WHERE sessions.device_id = devices.id
          AND devices.organization_id = $1
          AND devices.user_id = $2
          AND sessions.revoked_at IS NULL
        RETURNING sessions.id
      `,
      [organizationId, userId],
    );
    const revokedDevices = await client.query(
      `
        UPDATE devices
        SET
          revoked_at = COALESCE(revoked_at, NOW()),
          revoked_by_user_id = $3,
          revoked_reason = COALESCE(revoked_reason, 'membership_removed'),
          updated_at = NOW()
        WHERE organization_id = $1
          AND user_id = $2
          AND revoked_at IS NULL
        RETURNING id
      `,
      [organizationId, userId, actorUserId],
    );
    const anonymousPrincipal = await client.query<{ id: string }>(
      `
        INSERT INTO usage_analytics_principals (
          id, organization_id, anonymized, anonymized_at
        ) VALUES ($2, $1, TRUE, NOW())
        ON CONFLICT (organization_id) WHERE anonymized = TRUE
        DO UPDATE SET organization_id = EXCLUDED.organization_id
        RETURNING id::text
      `,
      [organizationId, randomUUID()],
    );
    const activePrincipal = await client.query<{ id: string }>(
      `
        SELECT id::text
        FROM usage_analytics_principals
        WHERE organization_id = $1 AND member_id = $2 AND anonymized = FALSE
        FOR UPDATE
      `,
      [organizationId, memberId],
    );
    let anonymizedSources = 0;
    if (anonymousPrincipal.rows[0] && activePrincipal.rows[0]) {
      const anonymized = await client.query(
        `
          UPDATE usage_analytics_sources
          SET principal_id = $3
          WHERE organization_id = $1 AND principal_id = $2
          RETURNING id
        `,
        [
          organizationId,
          activePrincipal.rows[0].id,
          anonymousPrincipal.rows[0].id,
        ],
      );
      anonymizedSources = anonymized.rowCount ?? 0;
      await client.query(
        `DELETE FROM usage_analytics_principals WHERE organization_id = $1 AND id = $2`,
        [organizationId, activePrincipal.rows[0].id],
      );
    }
    await client.query("DELETE FROM member WHERE id = $1", [memberId]);
    // Someone who belongs elsewhere stays signed in to those workspaces, and
    // someone leaving by choice stays signed in to start another. Only a person
    // removed from their last workspace has nothing left to be signed in to.
    const otherMembership = await client.query(
      `SELECT 1 FROM member WHERE "userId" = $1 LIMIT 1`,
      [userId],
    );
    const revoked =
      otherMembership.rowCount || action === "member.left"
        ? await client.query(
            `
              UPDATE session
              SET "activeOrganizationId" = NULL, "updatedAt" = NOW()
              WHERE "userId" = $1 AND "activeOrganizationId" = $2
              RETURNING id
            `,
            [userId, organizationId],
          )
        : await client.query(
            `DELETE FROM session WHERE "userId" = $1 RETURNING id`,
            [userId],
          );
    await client.query(
      `
        UPDATE organization_policies
        SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $2
        WHERE organization_id = $1
      `,
      [organizationId, actorUserId],
    );
    await recordAuditEvent(client, {
      action,
      actorUserId,
      organizationId,
      metadata: {
        revokedBrowserSessions: revoked.rowCount ?? 0,
        revokedDesktopSessions: revokedDeviceSessions.rowCount ?? 0,
        revokedDevices: revokedDevices.rowCount ?? 0,
        anonymizedUsageSources: anonymizedSources,
      },
      subjectId: userId,
      subjectType: "user",
    });
    await recordAuditEvent(client, {
      action: "usage.member_anonymized",
      actorUserId,
      organizationId,
      metadata: { sources: anonymizedSources },
      subjectId: null,
      subjectType: "former_members",
    });
  }
}
