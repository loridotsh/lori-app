import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CloudProject, CloudProjectDetail, ProjectAccess, ProjectAction, ProjectCapabilities, ProjectGrant, ProjectMemberships, ProjectPolicy, ProjectRole, ProjectStatus } from "@lori-enterprise/contracts";
import type { ManagedProject, ProjectManagementFilters, ProjectManagementPage, ProjectAssignmentSummary } from "@lori-enterprise/contracts";
import { IdentityError } from "../../auth/identity-service.js";
import { recordAuditEvent } from "../../auth/audit.js";
import type { CloudActor, CloudWorkService } from "../service.js";
import { sessionHash } from "../extensions/security.js";
import { ProjectKeyring, openProjectValue, sealProjectValue } from "./crypto.js";
import { bindProjectContext, projectContext, sealText } from "./content.js";
import { DEFAULT_PROJECT_POLICY, resolveProjectAccess } from "./policy.js";
import { delegationApproves, resolveProjectPolicy, type ProjectEffectiveAccess, type ResolvedProjectPolicy } from "@lori-enterprise/contracts";
import { providerGatewayDefinition } from "../../catalog.js";

export interface ProjectRow {
  id: string; organization_id: string; content: unknown; wrapped_key: unknown;
  policy: ProjectPolicy; status: ProjectStatus; revision: number; access_revision: number;
  created_at: Date; updated_at: Date; purge_after: Date | null;
}
interface Description { name: string; description: string; instructions: string }
const missing = () => new IdentityError(404, "project_not_found", "Project was not found.");
const refused = () => new IdentityError(403, "project_action_denied", "You do not have permission for this project action.");
const conflict = () => new IdentityError(409, "project_revision_conflict", "This project changed. Reload it before trying again.");
export class CloudProjects {
  private keyring: ProjectKeyring | null = null;
  constructor(private cloud: CloudWorkService) {
    try { if (cloud.config.cloud?.projectKeysFile) this.keyring = ProjectKeyring.fromFile(cloud.config.cloud.projectKeysFile); } catch { /* Availability fails closed, private Work remains available. */ }
  }
  async ready(c: PoolClient): Promise<boolean> {
    if (!this.cloud.config.cloud?.projectsEnabled || !this.keyring) return false;
    const role = (await c.query<{ unsafe: boolean }>("SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relkind IN ('r','p') AND pg_has_role(r.oid,t.relowner,'MEMBER')) AS unsafe FROM pg_roles r WHERE rolname=current_user")).rows[0];
    if (role?.unsafe !== false) return false;
    try {
      let check = (await c.query("SELECT wrapped_key FROM cloud_work_project_key_check WHERE singleton")).rows[0];
      if (!check) {
        const probe = this.keyring.create("lori-key-check", "00000000-0000-0000-0000-000000000000");
        try { await c.query("INSERT INTO cloud_work_project_key_check(singleton,wrapped_key) VALUES(TRUE,$1) ON CONFLICT DO NOTHING", [JSON.stringify(probe.wrapped)]); }
        finally { probe.context.key.fill(0); }
        check = (await c.query("SELECT wrapped_key FROM cloud_work_project_key_check WHERE singleton")).rows[0];
      }
      this.keyring.unwrap("lori-key-check", "00000000-0000-0000-0000-000000000000", check.wrapped_key).key.fill(0);
      return true;
    } catch { return false; }
  }
  private async requireReady(c: PoolClient) {
    if (!(await this.ready(c))) throw new IdentityError(503, "projects_unavailable", "Projects are unavailable. An administrator must finish project storage setup.");
  }
  /** Owner or Admin, from the verified membership row; the actor's request fields never decide this. */
  async isAdmin(c: PoolClient, a: CloudActor) {
    return (await c.query("SELECT 1 FROM member WHERE id=$1 AND \"organizationId\"=$2 AND \"userId\"=$3 AND role IN ('owner','admin')", [a.memberId, a.organizationId, a.userId])).rowCount === 1;
  }
  async requireAdmin(c: PoolClient, a: CloudActor) { if (!(await this.isAdmin(c, a))) throw refused(); }
  async canCreate(c: PoolClient, a: CloudActor) {
    if (await this.isAdmin(c, a)) return true;
    return (await c.query("SELECT 1 FROM cloud_work_project_creation_grants g WHERE g.organization_id=$1 AND (g.member_id=$2 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$2)) LIMIT 1", [a.organizationId, a.memberId])).rowCount === 1;
  }
  async capabilities(a: CloudActor): Promise<ProjectCapabilities> {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false);
      const available = await this.ready(c);
      const canAdminister = await this.isAdmin(c, a);
      let canManageProjects = available && canAdminister;
      if (available && !canAdminister && (await this.cloud.workPolicy(a.organizationId, a.memberId, c)).enabled) {
        const candidates = (await c.query<ProjectRow>("SELECT p.* FROM cloud_work_projects p WHERE p.organization_id=$1 AND p.status<>'deleted' AND EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND g.role='manager' AND (g.member_id=$2 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$2)))", [a.organizationId, a.memberId])).rows;
        for (const project of candidates) {
          const access = await this.permissions(c, a, project);
          if (access.actions.some(action => ["members.manage", "connections.manage", "instructions.write"].includes(action))) { canManageProjects = true; break; }
        }
      }
      return { version: 1, available, desktopAvailable: available && this.cloud.config.cloud?.desktopProjectsEnabled === true, canCreate: available && await this.canCreate(c, a), canAdminister, canManageProjects };
    });
  }
  async directory(a: CloudActor, projectId?: string) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireReady(c);
      if (!(await this.isAdmin(c, a))) {
        if (!projectId) throw refused();
        await this.cloud.ensure(c, a); await this.authorize(c, a, projectId, "members.manage");
      }
      const members = (await c.query('SELECT m.id,u.name,u.email FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 ORDER BY u.name,m.id LIMIT 2500', [a.organizationId])).rows;
      const teams = (await c.query("SELECT id,name FROM team WHERE organization_id=$1 ORDER BY name,id LIMIT 500", [a.organizationId])).rows;
      return { members, teams };
    });
  }
  async creationPolicy(a: CloudActor, input?: { expectedRevision: number; grants: { kind: "member" | "team"; subjectId: string }[] }) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireAdmin(c, a); await this.requireReady(c);
      await c.query("INSERT INTO cloud_work_project_creation_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING", [a.organizationId]);
      const row = (await c.query("SELECT revision FROM cloud_work_project_creation_settings WHERE organization_id=$1 FOR UPDATE", [a.organizationId])).rows[0]!;
      if (input) {
        if (row.revision !== input.expectedRevision) throw conflict();
        const seen = new Set<string>();
        for (const grant of input.grants) {
          const key = `${grant.kind}:${grant.subjectId}`;
          if (seen.has(key)) throw new IdentityError(400, "project_duplicate_grant", "Assign each member or team only once.");
          seen.add(key);
          const query = grant.kind === "member" ? 'SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2' : "SELECT 1 FROM team WHERE id=$1 AND organization_id=$2";
          if (!(await c.query(query, [grant.subjectId, a.organizationId])).rowCount) throw missing();
        }
        await c.query("DELETE FROM cloud_work_project_creation_grants WHERE organization_id=$1", [a.organizationId]);
        for (const g of input.grants) await c.query("INSERT INTO cloud_work_project_creation_grants(id,organization_id,member_id,team_id) VALUES($1,$2,$3,$4)", [randomUUID(), a.organizationId, g.kind === "member" ? g.subjectId : null, g.kind === "team" ? g.subjectId : null]);
        await c.query("UPDATE cloud_work_project_creation_settings SET revision=revision+1 WHERE organization_id=$1", [a.organizationId]);
        await recordAuditEvent(c, { action: "work.project.creation_policy.updated", actorUserId: a.userId, organizationId: a.organizationId, metadata: { grantCount: input.grants.length } });
      }
      const grants = (await c.query("SELECT member_id,team_id FROM cloud_work_project_creation_grants WHERE organization_id=$1 ORDER BY id", [a.organizationId])).rows;
      return { revision: row.revision + (input ? 1 : 0), grants: grants.map(g => ({ kind: g.member_id ? "member" as const : "team" as const, subjectId: g.member_id ?? g.team_id })) };
    });
  }
  private async row(c: PoolClient, a: Pick<CloudActor, "organizationId">, id: string, lock = false) {
    const row = (await c.query<ProjectRow>(`SELECT * FROM cloud_work_projects WHERE id=$1 AND organization_id=$2 ${lock ? "FOR UPDATE" : "FOR SHARE"}`, [id, a.organizationId])).rows[0];
    if (!row) throw missing();
    return row;
  }
  async bindInternal(c: PoolClient, organizationId: string, projectId: string) {
    await this.requireReady(c);
    const bound = projectContext(c);
    if (bound && (bound.organizationId !== organizationId || bound.projectId !== projectId)) throw missing();
    await c.query("SELECT set_config('lori.organization_id',$1,true)", [organizationId]);
    await c.query("SELECT organization_id FROM organization_policies WHERE organization_id=$1 FOR SHARE", [organizationId]);
    const row = await this.row(c, { organizationId }, projectId);
    const existing = projectContext(c);
    if (!existing) await bindProjectContext(c, this.keyring!.unwrap(organizationId, projectId, row.wrapped_key));
    else if (existing.projectId !== projectId || existing.organizationId !== organizationId) throw refused();
    return row;
  }
  private async permissions(c: PoolClient, a: CloudActor, row: ProjectRow): Promise<ProjectAccess> {
    const blocked = (await c.query("SELECT 1 FROM cloud_work_project_blocks WHERE project_id=$1 AND member_id=$2", [row.id, a.memberId])).rowCount === 1;
    const grants = await c.query<{ role: ProjectRole; denied_actions: ProjectAction[] }>("SELECT role,denied_actions FROM cloud_work_project_grants WHERE project_id=$1 AND organization_id=$2 AND (member_id=$3 OR team_id IN (SELECT team_id FROM team_member WHERE member_id=$3))", [row.id, a.organizationId, a.memberId]);
    // Organization administrators hold full shared-project access without grants or access requests.
    const administrator = await this.isAdmin(c, a);
    return { ...resolveProjectAccess({ grants: grants.rows.map(g => ({ role: g.role, deniedActions: g.denied_actions })), blocked, policy: row.policy, status: row.status, accessRevision: row.access_revision, administrator }), memberId: a.memberId };
  }
  async authorize(c: PoolClient, a: CloudActor, id: string, action: ProjectAction = "read") {
    if (a.deviceId && !this.cloud.config.cloud?.desktopProjectsEnabled) throw new IdentityError(503, "projects_unavailable", "Desktop projects are not enabled on this Enterprise server.");
    if (a.selectedProjectId && a.selectedProjectId !== id) throw missing();
    await this.requireReady(c);
    // Callers establish current membership/session/Work policy before this point.
    const row = await this.bindInternal(c, a.organizationId, id);
    const access = await this.permissions(c, a, row);
    if (!access.actions.includes(action)) throw missing();
    if (access.audited) await recordAuditEvent(c, { action: "work.project.admin_content_read", organizationId: a.organizationId, actorUserId: a.userId, subjectType: "project", subjectId: id });
    return { row, access };
  }
  async resource(c: PoolClient, a: CloudActor, kind: "conversation" | "run" | "file", id: string, action: ProjectAction = "read") {
    const row = (await c.query<{ project_id: string }>("SELECT project_id FROM cloud_work_project_resource_scopes WHERE kind=$1 AND resource_id=$2 AND organization_id=$3", [kind, id, a.organizationId])).rows[0];
    if (a.selectedProjectId && row?.project_id !== a.selectedProjectId) throw missing();
    if (row && projectContext(c) && projectContext(c)!.projectId !== row.project_id) throw missing();
    if (row) await this.authorize(c, a, row.project_id, action);
    return row?.project_id ?? null;
  }
  private description(c: PoolClient, row: ProjectRow) { return openProjectValue<Description>(projectContext(c)!, "project", row.id, "content", row.content); }
  private dto(c: PoolClient, row: ProjectRow, access: ProjectAccess): CloudProjectDetail {
    return { id: row.id, ...this.description(c, row), status: row.status, revision: row.revision, accessRevision: row.access_revision,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), purgeAfter: row.purge_after?.toISOString() ?? null, policy: resolveProjectPolicy(row.policy), access };
  }
  async list(a: CloudActor, admin = false, after?: string, limit = 50) {
    if (a.deviceId && !this.cloud.config.cloud?.desktopProjectsEnabled) throw new IdentityError(503, "projects_unavailable", "Desktop projects are not enabled on this Enterprise server.");
    // Each item has a distinct verified scope; no transaction switches projects.
    const ids = await this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, !admin); await this.requireReady(c);
      if (admin) await this.requireAdmin(c, a);
      // Administrators discover every shared project; others only those granted to them.
      const administrator = admin || await this.isAdmin(c, a);
      return (await c.query<{ id: string }>(`SELECT p.id FROM cloud_work_projects p WHERE p.organization_id=$1 AND $2::text IS NOT NULL AND ($3::uuid IS NULL OR p.id>$3)
        ${admin ? "" : "AND p.status<>'deleted' AND ($5::boolean OR (NOT EXISTS(SELECT 1 FROM cloud_work_project_blocks b WHERE b.project_id=p.id AND b.member_id=$2) AND EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND (g.member_id=$2 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$2)))))"}
        ORDER BY p.id LIMIT $4`, [a.organizationId, a.memberId, after ?? null, limit + 1, ...(admin ? [] : [administrator])])).rows;
    });
    const projects: CloudProject[] = [];
    for (const item of ids.slice(0, limit)) {
      try {
        const project = await this.cloud.transaction(async c => {
          await this.cloud.ensure(c, a, !admin);
          if (admin) await this.requireAdmin(c, a);
          const row = await this.bindInternal(c, a.organizationId, item.id);
          const access = await this.permissions(c, a, row);
          if (!admin && !access.actions.includes("read")) return null;
          const full = this.dto(c, row, access);
          // Inventory never returns instructions or content policy to unauthorized readers.
          const { instructions: _instructions, policy: _policy, ...summary } = full;
          return summary;
        });
        if (project) projects.push(project);
      } catch (e) { if (!(e instanceof IdentityError && e.statusCode === 404)) throw e; }
    }
    return { projects, nextCursor: ids.length > limit ? ids[limit - 1]!.id : null };
  }
  async detail(a: CloudActor, id: string) {
    return this.cloud.transaction(async c => { await this.cloud.ensure(c, a); const { row, access } = await this.authorize(c, a, id); return this.dto(c, row, access); });
  }
  /** A separate inventory for Manage; never changes member discovery or chat. */
  async managementList(a: CloudActor, filters: ProjectManagementFilters = {}, after?: string, limit = 50): Promise<ProjectManagementPage> {
    const capabilities = await this.capabilities(a);
    if (!capabilities.available) throw new IdentityError(503, "projects_unavailable", "An administrator must finish project storage setup.");
    if (!capabilities.canAdminister && !capabilities.canManageProjects && !capabilities.canCreate) throw refused();
    const admin = capabilities.canAdminister;
    const inventory = await this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, !admin); await this.requireReady(c);
      if (admin) await this.requireAdmin(c, a);
      const criteria = `FROM cloud_work_projects p WHERE p.organization_id=$1 AND ($3::uuid IS NULL OR p.id>$3)
        ${admin ? "" : "AND p.status<>'deleted' AND NOT EXISTS(SELECT 1 FROM cloud_work_project_blocks b WHERE b.project_id=p.id AND b.member_id=$2) AND EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND g.role='manager' AND (g.member_id=$2 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$2)))"}
        AND $2::text IS NOT NULL AND $8::int>0
        AND ($4::uuid IS NULL OR p.id=$4) AND ($5::text IS NULL OR p.status=$5)
        AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND g.team_id=$6))
        AND ($7::text IS NULL OR (
          NOT EXISTS(SELECT 1 FROM cloud_work_project_blocks b WHERE b.project_id=p.id AND b.member_id=$7)
          AND EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND (g.member_id=$7 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$7)))
          AND NOT EXISTS(SELECT 1 FROM cloud_work_project_grants g WHERE g.project_id=p.id AND g.denied_actions ? 'read' AND (g.member_id=$7 OR g.team_id IN (SELECT team_id FROM team_member WHERE member_id=$7)))
        ))`;
      const params = [a.organizationId, a.memberId, after ?? null, filters.projectId ?? null, filters.status ?? null, filters.teamId ?? null, filters.memberId ?? null, limit + 1];
      const ids = (await c.query<{ id: string }>(`SELECT p.id ${criteria} ORDER BY p.id LIMIT $8`, params)).rows;
      const totals = admin && !after ? (await c.query<{ total: number; active_count: number }>(`SELECT count(*)::int AS total,count(*) FILTER(WHERE p.status='active')::int AS active_count ${criteria}`, params)).rows[0] : undefined;
      const canCreate = capabilities.canCreate && (await this.cloud.workPolicy(a.organizationId, a.memberId, c)).enabled;
      return { ids, totals, canCreate };
    });
    const projects: ManagedProject[] = [];
    for (const item of inventory.ids.slice(0, limit)) {
      try {
        const result = await this.cloud.transaction(async c => {
          await this.cloud.ensure(c, a, !admin);
          if (admin) await this.requireAdmin(c, a);
          const row = await this.bindInternal(c, a.organizationId, item.id);
          const access = await this.permissions(c, a, row);
          if (!admin && !access.actions.some(action => ["instructions.write", "members.manage", "connections.manage"].includes(action))) return null;
          const canSeeAssignments = admin || access.actions.includes("members.manage");
          if (!canSeeAssignments && (filters.teamId || filters.memberId)) return null;
          const full = this.dto(c, row, access);
          const query = filters.query?.trim().toLocaleLowerCase();
          if (query && !`${full.name} ${full.description}`.toLocaleLowerCase().includes(query)) return null;
          const summary: ManagedProject = { id: full.id, name: full.name, description: full.description, status: full.status, revision: full.revision, accessRevision: full.accessRevision, createdAt: full.createdAt, updatedAt: full.updatedAt, purgeAfter: full.purgeAfter, access: full.access };
          if (canSeeAssignments) summary.assignments = await this.assignmentSummary(c, a.organizationId, full.id);
          return summary;
        });
        if (result) projects.push(result);
      } catch (error) { if (!(error instanceof IdentityError && error.statusCode === 404)) throw error; }
    }
    return { projects, nextCursor: inventory.ids.length > limit ? inventory.ids[limit - 1]!.id : null, canCreate: inventory.canCreate, canAdminister: admin, ...(inventory.totals ? { total: inventory.totals.total, activeCount: inventory.totals.active_count } : {}) };
  }
  private async assignmentSummary(c: PoolClient, organizationId: string, projectId: string): Promise<ProjectAssignmentSummary> {
    const teams = (await c.query<{ id: string; name: string; role: ProjectRole; total: number }>("SELECT t.id,t.name,g.role,count(*) OVER()::int AS total FROM cloud_work_project_grants g JOIN team t ON t.id=g.team_id WHERE g.project_id=$1 AND t.organization_id=$2 ORDER BY t.name,t.id LIMIT 5", [projectId, organizationId])).rows;
    const members = (await c.query<{ id: string; name: string; role: ProjectRole; blocked: boolean; total: number }>(`SELECT m.id,u.name,g.role,count(*) OVER()::int AS total,EXISTS(SELECT 1 FROM cloud_work_project_blocks b WHERE b.project_id=$1 AND b.member_id=m.id) AS blocked FROM cloud_work_project_grants g JOIN member m ON m.id=g.member_id JOIN "user" u ON u.id=m."userId" WHERE g.project_id=$1 AND m."organizationId"=$2 ORDER BY u.name,m.id LIMIT 5`, [projectId, organizationId])).rows;
    const blocked = (await c.query<{ count: number }>("SELECT count(*)::int AS count FROM cloud_work_project_blocks WHERE project_id=$1", [projectId])).rows[0]!.count;
    return { teams: teams.map(({ total: _total, ...team }) => team), members: members.map(({ total: _total, ...member }) => member), teamCount: teams[0]?.total ?? 0, directMemberCount: members[0]?.total ?? 0, blockedMemberCount: blocked };
  }
  async instructions(c: PoolClient, a: CloudActor, id: string) {
    const { row } = await this.authorize(c, a, id);
    return this.description(c, row);
  }
  async create(a: CloudActor, input: Description & { requestId: string }) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a); await this.requireReady(c);
      if (!(await this.canCreate(c, a))) throw refused();
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-create:${input.requestId}`]);
      // Creation IDs are stable across transport retries and cannot adopt existing projects.
      const prior = (await c.query<ProjectRow>("SELECT * FROM cloud_work_projects WHERE id=$1 AND organization_id=$2", [input.requestId, a.organizationId])).rows[0];
      if (prior) {
        const { row, access } = await this.authorize(c, a, prior.id, "instructions.write");
        const description = this.description(c, row);
        if (description.name !== input.name || description.description !== input.description || description.instructions !== input.instructions) throw conflict();
        return this.dto(c, row, access);
      }
      const id = input.requestId, { context, wrapped } = this.keyring!.create(a.organizationId, id);
      await bindProjectContext(c, context);
      const description: Description = { name: input.name, description: input.description, instructions: input.instructions };
      const row = (await c.query<ProjectRow>("INSERT INTO cloud_work_projects(id,organization_id,content,wrapped_key,policy,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [id, a.organizationId, JSON.stringify(sealProjectValue(context, "project", id, "content", description)), JSON.stringify(wrapped), JSON.stringify(DEFAULT_PROJECT_POLICY), a.memberId])).rows[0]!;
      await c.query("INSERT INTO cloud_work_project_grants(id,project_id,organization_id,member_id,role) VALUES($1,$2,$3,$4,'manager')", [randomUUID(), id, a.organizationId, a.memberId]);
      await c.query("INSERT INTO cloud_work_conversations(id,organization_id,member_id,project_id,is_project_root,title,created_by) VALUES($1,$2,NULL,$1,TRUE,$3,$4)", [id, a.organizationId, sealText(c, "conversation", id, "title", "Files"), a.memberId]);
      await c.query("INSERT INTO cloud_work_project_search(project_id) VALUES($1)", [id]);
      await recordAuditEvent(c, { action: "work.project.created", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "project", subjectId: id });
      return this.dto(c, row, await this.permissions(c, a, row));
    });
  }
  async governance(a: CloudActor, id: string) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireReady(c); await this.requireAdmin(c, a);
      const row = await this.row(c, a, id);
      return { revision: row.revision, status: row.status, policy: resolveProjectPolicy(row.policy) };
    });
  }
  async update(a: CloudActor, id: string, input: Partial<Description> & { expectedRevision: number; policy?: ProjectPolicy }) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false);
      await this.requireReady(c);
      const row = await this.row(c, a, id, true);
      await this.bindInternal(c, a.organizationId, id);
      if (await this.isAdmin(c, a)) { /* Admins may manage policy without opening content. */ }
      else { await this.cloud.ensure(c, a); await this.authorize(c, a, id, "instructions.write"); if (input.policy) throw refused(); }
      if (row.status !== "active" || row.revision !== input.expectedRevision) throw conflict();
      if (input.policy) input.policy = await this.checkedPolicy(c, a, row.policy, input.policy);
      const prior = this.description(c, row);
      const description = { name: input.name ?? prior.name, description: input.description ?? prior.description, instructions: input.instructions ?? prior.instructions };
      const updated = (await c.query<ProjectRow>("UPDATE cloud_work_projects SET content=$2,policy=$3,revision=revision+1,access_revision=access_revision+1,updated_at=NOW() WHERE id=$1 RETURNING *", [id, JSON.stringify(sealProjectValue(projectContext(c)!, "project", id, "content", description)), JSON.stringify(input.policy ?? row.policy)])).rows[0]!;
      await this.invalidate(c, id);
      await recordAuditEvent(c, { action: "work.project.updated", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "project", subjectId: id, metadata: { changedFields: Object.keys(input).filter(key => key !== "expectedRevision"), ...(input.policy ? { policyBefore: row.policy, policyAfter: input.policy } : {}) } });
      // A governance write cannot be used to obtain the unmodified instructions.
      return { revision: updated.revision, accessRevision: updated.access_revision };
    });
  }
  /**
   * Resource modes changed what a nonempty list means (an assignment, not a
   * restriction), so a write must say which mode it intends. Newly assigned
   * resources must be organization-approved; existing ones may stay as saved.
   */
  private async checkedPolicy(c: PoolClient, a: CloudActor, previous: ProjectPolicy, next: ProjectPolicy): Promise<ResolvedProjectPolicy> {
    const listed = next.providerModels.length > 0 || next.pluginIds.length > 0 || (next.skillIds?.length ?? 0) > 0;
    if (listed && (!next.providerMode || !next.pluginMode || !next.skillMode))
      throw new IdentityError(409, "project_policy_upgrade_required", "Project resources now use explicit modes. Reload the page and choose whether this project inherits members' access or uses its own assignments.");
    const resolved = resolveProjectPolicy(next);
    const before = resolveProjectPolicy(previous);
    const approved = (await this.cloud.work.delegation(a.organizationId, c)).effective;
    const unapproved: string[] = [];
    for (const row of resolved.providerModels) {
      if (!approved.managedCatalog.some(item => item.type === "provider" && item.id === row.providerId) && !before.providerModels.some(p => p.providerId === row.providerId))
        unapproved.push(`provider ${row.providerId}`);
      for (const model of row.modelIds) {
        const existing = before.providerModels.some(p => p.providerId === row.providerId && p.modelIds.includes(model));
        if (!existing && !approved.providerModels.some(p => p.providerId === row.providerId && p.modelIds.includes(model)))
          unapproved.push(`model ${row.providerId}/${model}`);
      }
    }
    const extensionApproved = (kind: "plugin" | "skill", id: string) => delegationApproves(approved, { id, type: kind });
    for (const id of resolved.pluginIds) if (!before.pluginIds.includes(id) && !extensionApproved("plugin", id)) unapproved.push(`plugin ${id}`);
    for (const id of resolved.skillIds) if (!before.skillIds.includes(id) && !extensionApproved("skill", id)) unapproved.push(`skill ${id}`);
    if (unapproved.length)
      throw new IdentityError(403, "project_resource_not_approved", `Not approved by the organization: ${unapproved.slice(0, 5).join(", ")}${unapproved.length > 5 ? `, and ${unapproved.length - 5} more` : ""}. Approve it in Work access first.`);
    return resolved;
  }
  async invalidate(c: PoolClient, projectId: string) {
    await c.query("UPDATE cloud_work_project_search SET revision=revision+1,status='pending',snapshot=NULL,vectors=NULL,updated_at=NOW() WHERE project_id=$1", [projectId]);
    await c.query("UPDATE cloud_work_project_maintenance SET last_activity_at=NOW() WHERE project_id=$1", [projectId]);
  }
  /** A member's effective project access and resources, from the same resolvers enforcement uses. */
  async permissionPreview(a: CloudActor, id: string, memberId: string): Promise<ProjectEffectiveAccess> {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireReady(c);
      const row = await this.bindInternal(c, a.organizationId, id);
      if (!(await this.isAdmin(c, a))) { await this.cloud.ensure(c, a); await this.authorize(c, a, id, "members.manage"); }
      const member = (await c.query<{ user_id: string }>('SELECT "userId" AS user_id FROM member WHERE id=$1 AND "organizationId"=$2', [memberId, a.organizationId])).rows[0];
      if (!member) throw missing();
      const access = await this.permissions(c, { organizationId: a.organizationId, memberId, userId: member.user_id, role: "member" }, row);
      const scope = await this.cloud.work.resourceScope(a.organizationId, memberId, c, row.policy);
      const policy = scope.policy;
      if (!policy.enabled) access.actions = [];
      else if (!policy.memoryAllowed) access.actions = access.actions.filter(action => action !== "memory.write");
      const sources = (await c.query("SELECT id,member_id,team_id,role,denied_actions FROM cloud_work_project_grants WHERE project_id=$1 AND (member_id=$2 OR team_id IN (SELECT team_id FROM team_member WHERE member_id=$2)) ORDER BY id", [id, memberId])).rows;
      const blocked = !!(await c.query("SELECT 1 FROM cloud_work_project_blocks WHERE project_id=$1 AND member_id=$2", [id, memberId])).rowCount;
      const resolved = resolveProjectPolicy(row.policy);
      const gateways = (await c.query<{ provider_id: string }>("SELECT DISTINCT provider_id FROM organization_provider_gateways WHERE organization_id=$1 ORDER BY provider_id", [a.organizationId])).rows.map(r => r.provider_id);
      // Every model the member could plausibly expect here: assigned, granted, or approved.
      const candidates = new Map<string, Set<string>>();
      const add = (providerId: string, models: string[]) => { const set = candidates.get(providerId) ?? new Set<string>(); models.forEach(m => set.add(m)); candidates.set(providerId, set); };
      resolved.providerModels.forEach(p => add(p.providerId, p.modelIds));
      policy.providerModels.forEach(p => add(p.providerId, p.modelIds));
      const models = [...candidates].sort(([x], [y]) => x.localeCompare(y)).flatMap(([providerId, ids]) => [...ids].sort().map(modelId => {
        const decision = scope.model(providerId, modelId);
        const connected = gateways.includes(providerId);
        const providerName = (() => { try { return providerGatewayDefinition(providerId).name; } catch { return providerId; } })();
        return { id: modelId, name: modelId, providerId, providerName, allowed: decision.allowed && connected, ...(decision.allowed && !connected ? { reason: "not_connected" as const } : decision.reason ? { reason: decision.reason } : {}), ...(decision.source ? { source: decision.source } : {}) };
      }));
      const extension = (kind: "plugin" | "skill", item: { id: string; name: string }) => { const d = scope.extension(kind, item.id); return { id: item.id, name: item.name, allowed: d.allowed, ...(d.reason ? { reason: d.reason } : {}), ...(d.source ? { source: d.source } : {}) }; };
      return {
        access, workEnabled: policy.enabled, blocked, administrator: scope.administrator,
        sources: sources.map(g => ({ id: g.id, kind: g.member_id ? "member" as const : "team" as const, subjectId: g.member_id ?? g.team_id, role: g.role, deniedActions: g.denied_actions })),
        resources: {
          providerMode: resolved.providerMode, pluginMode: resolved.pluginMode, skillMode: resolved.skillMode, models,
          plugins: this.cloud.extensions.catalog.plugins.map(p => extension("plugin", p)),
          skills: this.cloud.extensions.catalog.skills.map(s => extension("skill", s)),
        },
      };
    });
  }
  async memberships(a: CloudActor, id: string): Promise<ProjectMemberships> {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireReady(c);
      const row = await this.bindInternal(c, a.organizationId, id);
      if (!(await this.isAdmin(c, a))) { await this.cloud.ensure(c, a); await this.authorize(c, a, id, "members.manage"); }
      const grants = (await c.query("SELECT * FROM cloud_work_project_grants WHERE project_id=$1 ORDER BY id", [id])).rows;
      const blocks = (await c.query("SELECT member_id FROM cloud_work_project_blocks WHERE project_id=$1 ORDER BY member_id", [id])).rows;
      return { grants: grants.map(g => ({ id: g.id, kind: g.member_id ? "member" : "team", subjectId: g.member_id ?? g.team_id, role: g.role, deniedActions: g.denied_actions } as ProjectGrant)), blocks: blocks.map(b => ({ memberId: b.member_id })), revision: row.access_revision };
    });
  }
  async setMemberships(a: CloudActor, id: string, input: { expectedRevision: number; grants: Omit<ProjectGrant, "id">[]; blocks: string[] }) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a, false); await this.requireReady(c);
      const row = await this.row(c, a, id, true);
      await this.bindInternal(c, a.organizationId, id);
      const admin = await this.isAdmin(c, a);
      if (!admin) { await this.cloud.ensure(c, a); await this.authorize(c, a, id, "members.manage"); }
      if (row.status !== "active" || row.access_revision !== input.expectedRevision) throw conflict();
      const existingBlocks = (await c.query<{ member_id: string }>("SELECT member_id FROM cloud_work_project_blocks WHERE project_id=$1", [id])).rows.map(b => b.member_id).sort();
      if (!admin && JSON.stringify(existingBlocks) !== JSON.stringify([...input.blocks].sort())) throw refused();
      const prior = (await c.query("SELECT member_id,team_id,role,denied_actions FROM cloud_work_project_grants WHERE project_id=$1", [id])).rows;
      if (!admin) {
        const own = await this.permissions(c, a, row);
        for (const previous of prior) {
          const replacement = input.grants.find(g => g.kind === (previous.member_id ? "member" : "team") && g.subjectId === (previous.member_id ?? previous.team_id));
          if (previous.denied_actions.some((action: ProjectAction) => !replacement?.deniedActions.includes(action))) throw refused();
        }
        for (const grant of input.grants) {
          const proposed = resolveProjectAccess({ grants: [grant], blocked: false, policy: row.policy, status: row.status, accessRevision: row.access_revision });
          if (proposed.actions.some(action => !own.actions.includes(action))) throw refused();
        }
      }
      // A delegated manager must not lock the project out of delegated management;
      // administrators always manage shared projects, so they may leave none.
      if (!admin && !input.grants.some(g => g.role === "manager" && g.kind === "member" && !input.blocks.includes(g.subjectId) && !g.deniedActions.includes("read")))
        throw new IdentityError(400, "project_manager_required", "Keep at least one directly assigned project manager.");
      const seen = new Set<string>();
      for (const grant of input.grants) {
        const key = `${grant.kind}:${grant.subjectId}`;
        if (seen.has(key)) throw new IdentityError(400, "project_duplicate_grant", "Each member or team may be assigned once.");
        seen.add(key);
        const query = grant.kind === "member" ? 'SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2' : "SELECT 1 FROM team WHERE id=$1 AND organization_id=$2";
        if (!(await c.query(query, [grant.subjectId, a.organizationId])).rowCount) throw missing();
      }
      for (const member of input.blocks) if (!(await c.query('SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2', [member, a.organizationId])).rowCount) throw missing();
      await c.query("DELETE FROM cloud_work_project_grants WHERE project_id=$1", [id]);
      for (const g of input.grants) await c.query("INSERT INTO cloud_work_project_grants(id,project_id,organization_id,member_id,team_id,role,denied_actions) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), id, a.organizationId, g.kind === "member" ? g.subjectId : null, g.kind === "team" ? g.subjectId : null, g.role, JSON.stringify(g.deniedActions)]);
      await c.query("DELETE FROM cloud_work_project_blocks WHERE project_id=$1", [id]);
      for (const member of input.blocks) await c.query("INSERT INTO cloud_work_project_blocks(project_id,organization_id,member_id) VALUES($1,$2,$3)", [id, a.organizationId, member]);
      await c.query("UPDATE cloud_work_projects SET access_revision=access_revision+1,revision=revision+1,updated_at=NOW() WHERE id=$1", [id]);
      await c.query("DELETE FROM cloud_work_project_admin_access WHERE project_id=$1", [id]);
      const before = new Map(prior.map(g => [`${g.member_id ? "member" : "team"}:${g.member_id ?? g.team_id}`, { role: g.role, deniedActions: [...g.denied_actions].sort() }]));
      const after = new Map(input.grants.map(g => [`${g.kind}:${g.subjectId}`, { role: g.role, deniedActions: [...g.deniedActions].sort() }]));
      const grantChanges = [...new Set([...before.keys(), ...after.keys()])].filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))).map(subject => ({ subject, previous: before.get(subject) ?? null, next: after.get(subject) ?? null }));
      await recordAuditEvent(c, { action: "work.project.members.updated", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "project", subjectId: id, metadata: { grantCount: input.grants.length, blockCount: input.blocks.length, grantChanges, blockedAdded: input.blocks.filter(member => !existingBlocks.includes(member)), blockedRemoved: existingBlocks.filter(member => !input.blocks.includes(member)) } });
      return { revision: row.access_revision + 1 };
    });
  }
  async adminAccess(a: CloudActor, id: string, reason: string) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a); await this.requireAdmin(c, a);
      const row = await this.bindInternal(c, a.organizationId, id);
      if (row.status === "deleted" || (await c.query("SELECT 1 FROM cloud_work_project_blocks WHERE project_id=$1 AND member_id=$2", [id, a.memberId])).rowCount) throw refused();
      const accessId = randomUUID();
      const result = (await c.query<{ expires_at: Date }>("INSERT INTO cloud_work_project_admin_access(id,project_id,organization_id,member_id,session_hash,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+INTERVAL '15 minutes') ON CONFLICT(project_id,member_id,session_hash) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,expires_at=EXCLUDED.expires_at RETURNING expires_at", [accessId, id, a.organizationId, a.memberId, sessionHash(a), JSON.stringify(sealProjectValue(projectContext(c)!, "admin_access", accessId, "reason", reason))])).rows[0]!;
      await recordAuditEvent(c, { action: "work.project.admin_access.started", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "project", subjectId: id, metadata: { accessId, expiresAt: result.expires_at.toISOString() } });
      return { expiresAt: result.expires_at.toISOString() };
    });
  }
  async lifecycle(a: CloudActor, id: string, status: ProjectStatus, expectedRevision: number) {
    return this.cloud.transaction(async c => {
      const settings = await this.cloud.ensure(c, a, false); await this.requireAdmin(c, a); await this.requireReady(c);
      const row = await this.row(c, a, id, true); await this.bindInternal(c, a.organizationId, id);
      if (row.revision !== expectedRevision || (row.purge_after && row.purge_after.getTime() <= Date.now())) throw conflict();
      await c.query("UPDATE cloud_work_projects SET status=$2,revision=revision+1,access_revision=access_revision+1,updated_at=NOW(),purge_after=CASE WHEN $2='deleted' THEN LEAST(clock_timestamp()+INTERVAL '30 days',(SELECT last_activity_at FROM cloud_work_project_maintenance WHERE project_id=$1)+make_interval(days=>$3)) ELSE NULL END WHERE id=$1", [id, status, settings.retentionDays]);
      await c.query("DELETE FROM cloud_work_project_admin_access WHERE project_id=$1", [id]);
      const runs = await c.query("SELECT * FROM cloud_work_runs WHERE project_id=$1 AND status IN ('queued','running','awaitingApproval') FOR UPDATE", [id]);
      for (const run of runs.rows) await this.cloud.terminal(c, this.cloud.decodeRun(c, run), "cancelled", "project_access_revoked");
      await this.invalidate(c, id);
      await recordAuditEvent(c, { action: `work.project.${status}`, actorUserId: a.userId, organizationId: a.organizationId, subjectType: "project", subjectId: id });
      return { revision: row.revision + 1 };
    });
  }
  async maintain() {
    const available = await this.cloud.transaction(c => this.ready(c));
    if (!available) return;
    const items = (await this.cloud.pool.query<{ project_id: string; organization_id: string }>("SELECT project_id,organization_id FROM cloud_work_project_maintenance ORDER BY checked_at NULLS FIRST,project_id LIMIT 20")).rows;
    for (const item of items) {
      try {
        const retained = await this.cloud.transaction(async c => {
          const project = await this.bindInternal(c, item.organization_id, item.project_id);
          const expired = (await c.query("SELECT 1 FROM cloud_work_project_maintenance p JOIN cloud_work_settings s ON s.organization_id=p.organization_id WHERE p.project_id=$1 AND ((p.purge_after IS NOT NULL AND p.purge_after<=NOW()) OR p.last_activity_at<NOW()-make_interval(days=>s.retention_days))", [project.id])).rowCount;
          if (expired) {
            await c.query("DELETE FROM cloud_work_projects WHERE id=$1", [project.id]);
            await recordAuditEvent(c, { action: "work.project.purged", organizationId: item.organization_id, subjectType: "project", subjectId: project.id });
            return false;
          }
          const runs = (await c.query("SELECT * FROM cloud_work_runs WHERE project_id=$1 AND status IN ('queued','running','awaitingApproval') ORDER BY id FOR UPDATE", [project.id])).rows;
          for (const raw of runs) {
            const run = this.cloud.decodeRun(c, raw);
            const member = (await c.query<{ user_id: string }>('SELECT "userId" AS user_id FROM member WHERE id=$1 AND "organizationId"=$2', [run.member_id, run.organization_id])).rows[0];
            let code: string | undefined;
            if (!member || project.status !== "active") code = "project_access_revoked";
            else {
              try {
                const actor: CloudActor = { organizationId: run.organization_id, memberId: run.member_id, userId: member.user_id, role: "member" };
                await this.cloud.ensure(c, actor); await this.authorize(c, actor, project.id, "chat");
                await this.cloud.assertRunSession(c, run, member.user_id);
                const provider = await this.cloud.providers.authorizeCloudRequest(run.organization_id, run.member_id, run.gateway_id, c, project.policy);
                if (!provider.allowedModels.includes(run.model_id)) code = "policy_revoked";
              } catch (e) { if (e instanceof IdentityError && [403,404].includes(e.statusCode)) code = e.code === "cloud_provider_denied" ? "policy_revoked" : "project_access_revoked"; else throw e; }
            }
            if (code) await this.cloud.terminal(c, run, "cancelled", code);
            else if (run.status === "queued" ? Date.now() - run.created_at.getTime() > 15 * 60000 : run.lease_until && run.lease_until.getTime() <= Date.now())
              await this.cloud.terminal(c, run, "interrupted", "worker_lease_expired");
          }
          const accesses = (await c.query("DELETE FROM cloud_work_project_admin_access WHERE project_id=$1 AND expires_at<=NOW() RETURNING id,member_id", [project.id])).rows;
          for (const access of accesses) await recordAuditEvent(c, { action: "work.project.admin_access.expired", organizationId: item.organization_id, subjectType: "project", subjectId: project.id, metadata: { accessId: access.id, memberId: access.member_id } });
          await c.query("DELETE FROM cloud_work_file_previews WHERE project_id=$1 AND ((status='ready' AND updated_at<NOW()-INTERVAL '6 hours') OR (status<>'ready' AND updated_at<NOW()-INTERVAL '15 minutes'))", [project.id]);
          return project.status === "active";
        });
        if (retained) {
          await this.cloud.expireStaleApprovals(this.cloud.config.cloud?.approvalTimeoutMinutes ?? 15, item);
          await this.cloud.projectRetrieval.rebuild(item.organization_id, item.project_id);
        }
      } catch {
        // A broken project never prevents private Work or other projects' maintenance.
        await this.cloud.pool.query("UPDATE cloud_work_project_maintenance SET checked_at=NOW() WHERE project_id=$1", [item.project_id]);
        continue;
      }
      await this.cloud.pool.query("UPDATE cloud_work_project_maintenance SET checked_at=NOW() WHERE project_id=$1", [item.project_id]);
    }
  }
}
