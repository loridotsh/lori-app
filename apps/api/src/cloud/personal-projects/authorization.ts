import type { PoolClient } from "pg";
import type {
  PersonalProjectCreationPermission,
  PersonalProjectStatus,
} from "@lori-enterprise/contracts";
import { IdentityError } from "../../auth/identity-service.js";
import type { CloudActor, CloudWorkService } from "../service.js";

export interface PersonalProjectRow {
  id: string;
  organization_id: string;
  member_id: string;
  name: string;
  description: string;
  instructions: string;
  status: PersonalProjectStatus;
  revision: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
  purge_after: Date | null;
}

export const DEFAULT_PERSONAL_PROJECT_LIMIT = 100;
export const DEFAULT_PERSONAL_PROJECT_RECOVERY_DAYS = 30;

/** Unknown, foreign and removed projects answer identically, so ids cannot be probed. */
export const personalProjectMissing = () =>
  new IdentityError(404, "personal_project_not_found", "Personal project was not found.");
export const personalProjectArchived = () =>
  new IdentityError(409, "personal_project_archived", "This personal project is archived. Restore it to continue.");

/** Who is asking, as far as row-level security is concerned. Only verified identities are accepted. */
export type PersonalIdentity = Pick<CloudActor, "organizationId" | "memberId">;

/**
 * The single place that decides who may create or open a personal project.
 * Every entry point (HTTP, tools, the worker's claim and round paths) goes
 * through it; nothing derives an owner from a request body.
 */
export class PersonalProjectAuthorization {
  constructor(private cloud: CloudWorkService) {}

  /** Transaction-local identity for row-level security. Call only with a verified actor or run. */
  async bind(c: PoolClient, who: PersonalIdentity) {
    await c.query("SELECT set_config('lori.organization_id',$1,true),set_config('lori.member_id',$2,true)", [who.organizationId, who.memberId]);
  }

  async isAdministrator(c: PoolClient, who: Pick<CloudActor, "organizationId" | "memberId">) {
    return (
      (await c.query("SELECT 1 FROM member WHERE id=$1 AND \"organizationId\"=$2 AND role IN ('owner','admin')", [who.memberId, who.organizationId])).rowCount === 1
    );
  }

  async settings(c: PoolClient, organizationId: string, lock = false) {
    const row = (
      await c.query<{ allow_all: boolean; max_per_member: number | null; revision: number }>(
        `SELECT allow_all,max_per_member,revision FROM cloud_work_personal_project_settings WHERE organization_id=$1 ${lock ? "FOR UPDATE" : ""}`,
        [organizationId],
      )
    ).rows[0];
    // A missing row is the defaults at revision 1, the revision its first save is checked against.
    return { allowAll: row?.allow_all ?? false, maxPerMember: row?.max_per_member ?? null, revision: row?.revision ?? 1 };
  }

  limit(maxPerMember: number | null) {
    return maxPerMember ?? this.cloud.config.cloud?.personalProjectLimit ?? DEFAULT_PERSONAL_PROJECT_LIMIT;
  }

  recoveryDays() {
    return this.cloud.config.cloud?.personalProjectRecoveryDays ?? DEFAULT_PERSONAL_PROJECT_RECOVERY_DAYS;
  }

  /**
   * Effective permission to create, and why. An explicit block beats every
   * grant; administrators hold a default grant; otherwise an organization-wide
   * switch or a member/team grant is needed. Owning a project never depends on
   * this: a member whose permission was removed keeps their existing projects.
   */
  async creationPermission(
    c: PoolClient,
    who: Pick<CloudActor, "organizationId" | "memberId">,
  ): Promise<PersonalProjectCreationPermission> {
    const blocked = await c.query("SELECT 1 FROM cloud_work_personal_project_creation_blocks WHERE organization_id=$1 AND member_id=$2", [who.organizationId, who.memberId]);
    if (blocked.rowCount) return { allowed: false, source: "blocked" };
    if (await this.isAdministrator(c, who)) return { allowed: true, source: "organization_admin" };
    const settings = await this.settings(c, who.organizationId);
    if (settings.allowAll) return { allowed: true, source: "everyone" };
    const member = await c.query("SELECT 1 FROM cloud_work_personal_project_creation_grants WHERE organization_id=$1 AND member_id=$2", [who.organizationId, who.memberId]);
    if (member.rowCount) return { allowed: true, source: "member_grant" };
    const team = await c.query(
      "SELECT 1 FROM cloud_work_personal_project_creation_grants g WHERE g.organization_id=$1 AND g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$2) LIMIT 1",
      [who.organizationId, who.memberId],
    );
    if (team.rowCount) return { allowed: true, source: "team_grant" };
    return { allowed: false, source: "none" };
  }

  async requireCreate(c: PoolClient, a: CloudActor) {
    const permission = await this.creationPermission(c, a);
    if (!permission.allowed)
      throw new IdentityError(403, "personal_project_creation_denied", "You are not allowed to create personal projects.");
    return permission;
  }

  async retained(c: PoolClient, who: Pick<CloudActor, "organizationId" | "memberId">) {
    return Number(
      (await c.query<{ n: string }>("SELECT count(*) AS n FROM cloud_work_personal_projects WHERE organization_id=$1 AND member_id=$2", [who.organizationId, who.memberId])).rows[0]!.n,
    );
  }

  /**
   * The caller's own project, or a non-disclosing 404. Deleted projects are
   * hidden unless the caller names the statuses it may see.
   */
  async own(
    c: PoolClient,
    a: Pick<CloudActor, "organizationId" | "memberId">,
    id: string,
    options: { lock?: "update" | "share"; statuses?: PersonalProjectStatus[] } = {},
  ): Promise<PersonalProjectRow> {
    await this.bind(c, a);
    const row = (
      await c.query<PersonalProjectRow>(
        `SELECT * FROM cloud_work_personal_projects WHERE id=$1 AND organization_id=$2 AND member_id=$3 ${options.lock === "update" ? "FOR UPDATE" : options.lock === "share" ? "FOR SHARE" : ""}`,
        [id, a.organizationId, a.memberId],
      )
    ).rows[0];
    if (!row || !(options.statuses ?? ["active", "archived"]).includes(row.status)) throw personalProjectMissing();
    return row;
  }

  /** Work in the project's chats needs an active project; archived ones are read-only. */
  requireActive(row: Pick<PersonalProjectRow, "status">) {
    if (row.status === "archived") throw personalProjectArchived();
    if (row.status !== "active") throw personalProjectMissing();
  }
}
