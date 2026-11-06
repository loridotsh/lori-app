import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CloudConversation,
  PersonalProject,
  PersonalProjectCapabilities,
  PersonalProjectCreationGrant,
  PersonalProjectCreationPolicy,
  PersonalProjectDetail,
  PersonalProjectEffectivePermission,
  PersonalProjectStatus,
} from "@lori-enterprise/contracts";
import { IdentityError } from "../../auth/identity-service.js";
import { recordAuditEvent } from "../../auth/audit.js";
import { fingerprint } from "../security.js";
import { conversationView, type CloudActor, type CloudWorkService } from "../service.js";
import {
  DEFAULT_PERSONAL_PROJECT_LIMIT,
  PersonalProjectAuthorization,
  personalProjectMissing,
  type PersonalProjectRow,
} from "./authorization.js";
import { PersonalProjectReferences } from "./references.js";
import { PersonalProjectContext } from "./context.js";

const ACTIVE_RUN = "('queued','running','awaitingApproval')";
const conflict = (code = "personal_project_revision_conflict", message = "This project changed. Reload it before trying again.") =>
  new IdentityError(409, code, message);
const iso = (d: Date) => d.toISOString();

interface Counted extends PersonalProjectRow { conversation_count: string; reference_count: string }
type Operation = "create" | "update" | "lifecycle" | "move" | "conversation" | "reference";

export class CloudPersonalProjects {
  readonly authorization: PersonalProjectAuthorization;
  readonly references: PersonalProjectReferences;
  readonly context: PersonalProjectContext;
  constructor(private cloud: CloudWorkService) {
    this.authorization = new PersonalProjectAuthorization(cloud);
    this.references = new PersonalProjectReferences(cloud, this);
    this.context = new PersonalProjectContext(cloud, this);
  }

  private summary(row: Counted): PersonalProject {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      archivedAt: row.archived_at ? iso(row.archived_at) : null,
      deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
      purgeAfter: row.purge_after ? iso(row.purge_after) : null,
      conversationCount: Number(row.conversation_count),
      referenceCount: Number(row.reference_count),
    };
  }
  private detailOf(row: Counted): PersonalProjectDetail {
    return { ...this.summary(row), instructions: row.instructions };
  }
  private async counted(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">, id: string, lock?: "update" | "share"): Promise<Counted> {
    const row = await this.authorization.own(c, a, id, { lock, statuses: ["active", "archived", "deleted"] });
    return this.withCounts(c, row);
  }
  private async withCounts(c: PoolClient, row: PersonalProjectRow): Promise<Counted> {
    const counts = (
      await c.query<{ conversations: string; refs: string }>(
        "SELECT (SELECT count(*) FROM cloud_work_conversations WHERE personal_project_id=$1) AS conversations, (SELECT count(*) FROM cloud_work_personal_project_references WHERE personal_project_id=$1) AS refs",
        [row.id],
      )
    ).rows[0]!;
    return { ...row, conversation_count: counts.conversations, reference_count: counts.refs };
  }

  /** Replays a completed operation; a changed body under the same request id is refused. */
  async idempotent<T>(c: PoolClient, a: CloudActor, requestId: string | undefined, operation: Operation, body: unknown, run: () => Promise<T>): Promise<T> {
    if (!requestId) return run();
    const fp = fingerprint({ operation, body });
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`personal-request:${a.organizationId}:${a.memberId}:${requestId}`]);
    const old = (
      await c.query<{ operation: string; fingerprint: string; response: T }>(
        "SELECT operation,fingerprint,response FROM cloud_work_personal_project_requests WHERE organization_id=$1 AND member_id=$2 AND request_id=$3",
        [a.organizationId, a.memberId, requestId],
      )
    ).rows[0];
    if (old) {
      if (old.operation !== operation || old.fingerprint !== fp) throw conflict("personal_project_idempotency_conflict", "This request id was already used for a different request.");
      return old.response;
    }
    const result = await run();
    await c.query(
      "INSERT INTO cloud_work_personal_project_requests(organization_id,member_id,request_id,operation,fingerprint,response) VALUES($1,$2,$3,$4,$5,$6)",
      [a.organizationId, a.memberId, requestId, operation, fp, JSON.stringify(result ?? null)],
    );
    return result;
  }

  private async audit(c: PoolClient, a: CloudActor, action: string, subjectId: string, metadata: Record<string, unknown> = {}) {
    // Names, instructions and references are owner-only: audit records identifiers and counts, never content.
    await recordAuditEvent(c, { action, actorUserId: a.userId, organizationId: a.organizationId, subjectType: "personal_project", subjectId, metadata });
  }

  /** Cloud Work must be on for this member; the personal-project layer adds nothing else to availability. */
  private async enabled(c: PoolClient, a: CloudActor) {
    await this.cloud.ensure(c, a, true);
    await this.authorization.bind(c, a);
  }

  // ---- Capabilities and administration ----

  async capabilities(a: CloudActor): Promise<PersonalProjectCapabilities> {
    return this.cloud.transaction(async (c) => {
      const settings = await this.cloud.ensure(c, a, false);
      await this.authorization.bind(c, a);
      const policy = await this.cloud.workPolicy(a.organizationId, a.memberId, c);
      const canAdminister = await this.authorization.isAdministrator(c, a);
      const org = await this.authorization.settings(c, a.organizationId);
      const limit = this.authorization.limit(org.maxPerMember);
      const recoveryDays = this.authorization.recoveryDays();
      const available = settings.enabled && policy.enabled && !!this.cloud.config.cloud?.workerSecret;
      if (!available) return { version: 1, available: false, canCreate: false, source: "unavailable", count: 0, limit, canAdminister, recoveryDays };
      const permission = await this.authorization.creationPermission(c, a);
      const count = await this.authorization.retained(c, a);
      return { version: 1, available: true, canCreate: permission.allowed && count < limit, source: permission.source, count, limit, canAdminister, recoveryDays };
    });
  }

  private async requireAdministrator(c: PoolClient, a: CloudActor) {
    if (!(await this.authorization.isAdministrator(c, a))) throw new IdentityError(403, "admin_required", "Administrator access is required.");
  }

  async directory(a: CloudActor) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a, false);
      await this.requireAdministrator(c, a);
      const members = (await c.query('SELECT m.id,u.name,u.email FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 ORDER BY u.name,m.id LIMIT 2500', [a.organizationId])).rows;
      const teams = (await c.query("SELECT id,name FROM team WHERE organization_id=$1 ORDER BY name,id LIMIT 500", [a.organizationId])).rows;
      return { members, teams };
    });
  }

  private async readPolicy(c: PoolClient, organizationId: string): Promise<PersonalProjectCreationPolicy> {
    const settings = await this.authorization.settings(c, organizationId);
    const grants = (await c.query<{ member_id: string | null; team_id: string | null }>("SELECT member_id,team_id FROM cloud_work_personal_project_creation_grants WHERE organization_id=$1 ORDER BY id", [organizationId])).rows;
    const blocks = (await c.query<{ member_id: string }>("SELECT member_id FROM cloud_work_personal_project_creation_blocks WHERE organization_id=$1 ORDER BY member_id", [organizationId])).rows;
    return {
      revision: settings.revision,
      allowAll: settings.allowAll,
      grants: grants.map((g): PersonalProjectCreationGrant => (g.member_id ? { kind: "member", subjectId: g.member_id } : { kind: "team", subjectId: g.team_id! })),
      blockedMemberIds: blocks.map((b) => b.member_id),
      maxPerMember: settings.maxPerMember,
      defaultMaxPerMember: this.cloud.config.cloud?.personalProjectLimit ?? DEFAULT_PERSONAL_PROJECT_LIMIT,
    };
  }

  async policy(a: CloudActor): Promise<PersonalProjectCreationPolicy> {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a, false);
      await this.requireAdministrator(c, a);
      return this.readPolicy(c, a.organizationId);
    });
  }

  async setPolicy(
    a: CloudActor,
    input: { expectedRevision: number; allowAll: boolean; grants: PersonalProjectCreationGrant[]; blockedMemberIds: string[]; maxPerMember: number | null },
  ): Promise<PersonalProjectCreationPolicy> {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a, false);
      await this.cloud.requireAdminMutation(c, a);
      const seen = new Set<string>();
      for (const grant of input.grants) {
        const key = `${grant.kind}:${grant.subjectId}`;
        if (seen.has(key)) throw new IdentityError(400, "personal_project_duplicate_grant", "Assign each member or team only once.");
        seen.add(key);
        const exists = grant.kind === "member"
          ? await c.query('SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2', [grant.subjectId, a.organizationId])
          : await c.query("SELECT 1 FROM team WHERE id=$1 AND organization_id=$2", [grant.subjectId, a.organizationId]);
        if (!exists.rowCount) throw new IdentityError(404, "personal_project_subject_not_found", "A selected member or team was not found.");
      }
      if (new Set(input.blockedMemberIds).size !== input.blockedMemberIds.length) throw new IdentityError(400, "personal_project_duplicate_grant", "Block each member only once.");
      for (const memberId of input.blockedMemberIds)
        if (!(await c.query('SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2', [memberId, a.organizationId])).rowCount)
          throw new IdentityError(404, "personal_project_subject_not_found", "A selected member or team was not found.");
      await c.query("INSERT INTO cloud_work_personal_project_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING", [a.organizationId]);
      const current = (await c.query<{ revision: number }>("SELECT revision FROM cloud_work_personal_project_settings WHERE organization_id=$1 FOR UPDATE", [a.organizationId])).rows[0]!;
      if (current.revision !== input.expectedRevision) throw conflict("personal_project_policy_conflict", "The creation policy changed. Reload it before trying again.");
      await c.query("UPDATE cloud_work_personal_project_settings SET allow_all=$2,max_per_member=$3,revision=revision+1 WHERE organization_id=$1", [a.organizationId, input.allowAll, input.maxPerMember]);
      await c.query("DELETE FROM cloud_work_personal_project_creation_grants WHERE organization_id=$1", [a.organizationId]);
      for (const g of input.grants)
        await c.query("INSERT INTO cloud_work_personal_project_creation_grants(id,organization_id,member_id,team_id) VALUES($1,$2,$3,$4)", [randomUUID(), a.organizationId, g.kind === "member" ? g.subjectId : null, g.kind === "team" ? g.subjectId : null]);
      await c.query("DELETE FROM cloud_work_personal_project_creation_blocks WHERE organization_id=$1", [a.organizationId]);
      for (const memberId of input.blockedMemberIds)
        await c.query("INSERT INTO cloud_work_personal_project_creation_blocks(organization_id,member_id) VALUES($1,$2)", [a.organizationId, memberId]);
      await recordAuditEvent(c, {
        action: "work.personal_project.policy.updated",
        actorUserId: a.userId,
        organizationId: a.organizationId,
        metadata: { allowAll: input.allowAll, grantCount: input.grants.length, blockCount: input.blockedMemberIds.length, maxPerMember: input.maxPerMember },
      });
      return this.readPolicy(c, a.organizationId);
    });
  }

  async effective(a: CloudActor, memberId: string): Promise<PersonalProjectEffectivePermission> {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a, false);
      await this.requireAdministrator(c, a);
      if (!(await c.query('SELECT 1 FROM member WHERE id=$1 AND "organizationId"=$2', [memberId, a.organizationId])).rowCount)
        throw new IdentityError(404, "personal_project_subject_not_found", "A selected member or team was not found.");
      return { memberId, ...(await this.authorization.creationPermission(c, { organizationId: a.organizationId, memberId })) };
    });
  }

  // ---- Lifecycle ----

  async create(a: CloudActor, input: { requestId: string; name: string; description: string; instructions: string }): Promise<PersonalProjectDetail> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.idempotent(c, a, input.requestId, "create", { name: input.name, description: input.description, instructions: input.instructions }, async () => {
        await this.authorization.requireCreate(c, a);
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`personal-quota:${a.organizationId}:${a.memberId}`]);
        const settings = await this.authorization.settings(c, a.organizationId);
        const limit = this.authorization.limit(settings.maxPerMember);
        if ((await this.authorization.retained(c, a)) >= limit)
          throw new IdentityError(409, "personal_project_limit", `You can keep up to ${limit} personal projects, including archived and recently deleted ones. Remove one to create another.`);
        const id = randomUUID();
        const row = (
          await c.query<PersonalProjectRow>(
            "INSERT INTO cloud_work_personal_projects(id,organization_id,member_id,name,description,instructions) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [id, a.organizationId, a.memberId, input.name, input.description, input.instructions],
          )
        ).rows[0]!;
        await this.audit(c, a, "work.personal_project.created", id);
        return this.detailOf(await this.withCounts(c, row));
      });
    });
  }

  async list(a: CloudActor, query: { status: PersonalProjectStatus; limit: number; cursor?: string }) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      if (query.cursor) {
        const anchor = await this.authorization.own(c, a, query.cursor, { statuses: ["active", "archived", "deleted"] }).catch(() => null);
        if (!anchor || anchor.status !== query.status) throw new IdentityError(404, "personal_project_cursor_invalid", "The cursor does not belong to this list.");
      }
      const rows = await c.query<Counted>(
        `SELECT p.*,
           (SELECT count(*) FROM cloud_work_conversations WHERE personal_project_id=p.id) AS conversation_count,
           (SELECT count(*) FROM cloud_work_personal_project_references WHERE personal_project_id=p.id) AS reference_count
         FROM cloud_work_personal_projects p
         WHERE p.organization_id=$1 AND p.member_id=$2 AND p.status=$3
           AND ($4::uuid IS NULL OR (p.updated_at,p.id)<(SELECT updated_at,id FROM cloud_work_personal_projects WHERE id=$4::uuid AND organization_id=$1 AND member_id=$2))
         ORDER BY p.updated_at DESC,p.id DESC LIMIT $5`,
        [a.organizationId, a.memberId, query.status, query.cursor ?? null, query.limit + 1],
      );
      return {
        projects: rows.rows.slice(0, query.limit).map((row) => this.summary(row)),
        nextCursor: rows.rows.length > query.limit ? rows.rows[query.limit - 1]!.id : null,
      };
    });
  }

  async detail(a: CloudActor, id: string): Promise<PersonalProjectDetail> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.detailOf(await this.counted(c, a, id));
    });
  }

  private async changed(c: PoolClient, row: PersonalProjectRow) {
    return this.detailOf(await this.withCounts(c, row));
  }

  async update(
    a: CloudActor,
    id: string,
    input: { requestId?: string; expectedRevision: number; name?: string; description?: string; instructions?: string },
  ): Promise<PersonalProjectDetail> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.idempotent(c, a, input.requestId, "update", { id, ...input, requestId: undefined }, async () => {
        const row = await this.authorization.own(c, a, id, { lock: "update" });
        this.authorization.requireActive(row);
        if (row.revision !== input.expectedRevision) throw conflict();
        const updated = (
          await c.query<PersonalProjectRow>(
            "UPDATE cloud_work_personal_projects SET name=$2,description=$3,instructions=$4,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *",
            [id, input.name ?? row.name, input.description ?? row.description, input.instructions ?? row.instructions],
          )
        ).rows[0]!;
        await this.audit(c, a, "work.personal_project.updated", id, { fields: ["name", "description", "instructions"].filter((f) => (input as Record<string, unknown>)[f] !== undefined) });
        return this.changed(c, updated);
      });
    });
  }

  /** Active -> archived -> active, and active/archived -> deleted -> active (restore) until the recovery window ends. */
  async lifecycle(
    a: CloudActor,
    id: string,
    input: { requestId: string; status: PersonalProjectStatus; expectedRevision: number },
  ): Promise<PersonalProjectDetail> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.idempotent(c, a, input.requestId, "lifecycle", { id, status: input.status, expectedRevision: input.expectedRevision }, async () => {
        const row = await this.authorization.own(c, a, id, { lock: "update", statuses: ["active", "archived", "deleted"] });
        if (row.revision !== input.expectedRevision) throw conflict();
        if (row.status === input.status) return this.changed(c, row);
        const to = input.status;
        const valid = (row.status === "active" && (to === "archived" || to === "deleted")) || (row.status === "archived" && (to === "active" || to === "deleted")) || (row.status === "deleted" && to === "active");
        if (!valid) throw new IdentityError(409, "personal_project_transition_invalid", "This project cannot move to that state.");
        if (row.status === "deleted" && row.purge_after && row.purge_after.getTime() <= Date.now())
          throw personalProjectMissing();
        if (to === "archived" || to === "deleted") {
          // Wait out in-flight work instead of stranding it with half its files and memory.
          const active = await c.query(`SELECT 1 FROM cloud_work_runs r JOIN cloud_work_conversations conv ON conv.id=r.conversation_id WHERE conv.personal_project_id=$1 AND r.status IN ${ACTIVE_RUN} LIMIT 1`, [id]);
          if (active.rowCount) throw conflict("personal_project_run_active", "A chat in this project is still working. Stop it or wait for it to finish.");
        }
        let updated: PersonalProjectRow;
        if (to === "archived") {
          updated = (await c.query<PersonalProjectRow>("UPDATE cloud_work_personal_projects SET status='archived',archived_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *", [id])).rows[0]!;
        } else if (to === "deleted") {
          updated = (
            await c.query<PersonalProjectRow>(
              "UPDATE cloud_work_personal_projects SET status='deleted',deleted_at=NOW(),purge_after=NOW()+make_interval(days=>$2),revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *",
              [id, this.authorization.recoveryDays()],
            )
          ).rows[0]!;
        } else {
          if (row.status === "deleted") {
            // Retention is a clock on a chat's last activity. Time spent deleted is not idle time.
            await c.query("UPDATE cloud_work_conversations SET updated_at=updated_at+(NOW()-$2::timestamptz) WHERE personal_project_id=$1", [id, row.deleted_at]);
          }
          updated = (await c.query<PersonalProjectRow>("UPDATE cloud_work_personal_projects SET status='active',archived_at=NULL,deleted_at=NULL,purge_after=NULL,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *", [id])).rows[0]!;
        }
        await this.audit(c, a, `work.personal_project.${to === "active" ? "restored" : to}`, id);
        return this.changed(c, updated);
      });
    });
  }

  // ---- Conversations ----

  async createConversation(a: CloudActor, projectId: string, input: { title: string; requestId?: string }): Promise<CloudConversation> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.idempotent(c, a, input.requestId, "conversation", { projectId, title: input.title }, async () => {
        const project = await this.authorization.own(c, a, projectId, { lock: "share" });
        this.authorization.requireActive(project);
        const id = randomUUID();
        const row = (
          await c.query(
            "INSERT INTO cloud_work_conversations(id,organization_id,member_id,title,created_by,personal_project_id) VALUES($1,$2,$3,$4,$3,$5) RETURNING *",
            [id, a.organizationId, a.memberId, input.title, projectId],
          )
        ).rows[0];
        return conversationView(row);
      });
    });
  }

  /** Moves a private chat into, between or out of the owner's personal projects. The id and transcript never change. */
  async moveConversation(
    a: CloudActor,
    conversationId: string,
    input: { requestId: string; personalProjectId: string | null; expectedRevision: number },
  ): Promise<CloudConversation> {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.idempotent(c, a, input.requestId, "move", { conversationId, personalProjectId: input.personalProjectId, expectedRevision: input.expectedRevision }, async () => {
        const conv = await this.cloud.ownConversation(c, a, conversationId, true);
        if (conv.is_project_root || conv.project_id) throw new IdentityError(409, "personal_project_scope", "Only private conversations can be filed in a personal project.");
        if (conv.revision !== input.expectedRevision) throw new IdentityError(409, "cloud_revision_conflict", "The conversation changed. Refresh and try again.");
        // Both projects are locked, in a fixed order, so concurrent moves and deletions serialize.
        const ids = [...new Set([conv.personal_project_id, input.personalProjectId].filter((x): x is string => !!x))].sort();
        for (const id of ids) await this.authorization.own(c, a, id, { lock: "update", statuses: ["active", "archived"] });
        if (input.personalProjectId) {
          const target = await this.authorization.own(c, a, input.personalProjectId);
          this.authorization.requireActive(target);
        }
        if ((conv.personal_project_id ?? null) === input.personalProjectId) return conversationView(conv);
        const active = await c.query(`SELECT 1 FROM cloud_work_runs WHERE conversation_id=$1 AND status IN ${ACTIVE_RUN}`, [conversationId]);
        if (active.rowCount) throw new IdentityError(409, "cloud_run_active", "Wait for this chat to finish before moving it.");
        const row = (
          await c.query(
            "UPDATE cloud_work_conversations SET personal_project_id=$2,revision=revision+1 WHERE id=$1 RETURNING *",
            [conversationId, input.personalProjectId],
          )
        ).rows[0];
        await this.audit(c, a, "work.personal_project.conversation_moved", input.personalProjectId ?? conv.personal_project_id!, { toProject: input.personalProjectId !== null });
        return conversationView({ ...row, title: conv.title });
      });
    });
  }

  // ---- Maintenance ----

  /** Permanently removes projects past their recovery window, with their chats, files and references. */
  async maintain() {
    await this.cloud.transaction(async (c) => {
      await c.query("SELECT set_config('lori.personal_scope','internal',true)");
      await c.query("DELETE FROM cloud_work_personal_project_requests WHERE created_at<NOW()-INTERVAL '7 days'");
      await c.query(
        `DELETE FROM cloud_work_personal_projects WHERE id IN (
           SELECT p.id FROM cloud_work_personal_projects p
           WHERE p.status='deleted' AND p.purge_after<NOW()
             AND NOT EXISTS(SELECT 1 FROM cloud_work_runs r JOIN cloud_work_conversations conv ON conv.id=r.conversation_id WHERE conv.personal_project_id=p.id AND r.status IN ${ACTIVE_RUN})
           ORDER BY p.purge_after LIMIT 50 FOR UPDATE OF p SKIP LOCKED)`,
      );
    });
  }
}
