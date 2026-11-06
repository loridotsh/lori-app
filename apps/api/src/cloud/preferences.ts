import type { PoolClient } from "pg";
import type { CloudApprovalMode, CloudMemberPreferences } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
import { recordAuditEvent } from "../auth/audit.js";
import type { CloudActor, CloudWorkService } from "./service.js";
import { projectContext } from "./projects/content.js";

export class CloudPreferences {
  constructor(private cloud: CloudWorkService) {}

  /** Call after ensure/lease: their organization lock fences policy updates. */
  async current(c: PoolClient, organizationId: string, memberId: string): Promise<CloudMemberPreferences> {
    const scope = projectContext(c);
    if (scope) {
      const policy = await this.cloud.workPolicy(organizationId, memberId, c);
      const project = await this.cloud.projects.bindInternal(c, organizationId, scope.projectId);
      await c.query("INSERT INTO cloud_work_project_preferences(project_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [scope.projectId, memberId]);
      const row = (await c.query("SELECT approval_mode,revision FROM cloud_work_project_preferences WHERE project_id=$1 AND member_id=$2 FOR UPDATE", [scope.projectId, memberId])).rows[0]!;
      const forcedAskMe = policy.forceAskMe || project.policy.forceAskMe;
      return { approvalMode: row.approval_mode, effectiveApprovalMode: forcedAskMe ? "askMe" : row.approval_mode, forcedAskMe, revision: row.revision };
    }
    await c.query("INSERT INTO cloud_work_member_preferences(organization_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [organizationId, memberId]);
    const row = (await c.query("SELECT approval_mode,revision FROM cloud_work_member_preferences WHERE organization_id=$1 AND member_id=$2 FOR UPDATE", [organizationId, memberId])).rows[0]!;
    const policy = await this.cloud.workPolicy(organizationId, memberId, c);
    return { approvalMode: row.approval_mode, effectiveApprovalMode: policy.forceAskMe ? "askMe" : row.approval_mode,
      forcedAskMe: policy.forceAskMe, revision: row.revision };
  }
  async get(actor: CloudActor, projectId?: string) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, actor);
      if (projectId) await this.cloud.projects.authorize(c, actor, projectId);
      return this.current(c, actor.organizationId, actor.memberId);
    });
  }
  async update(actor: CloudActor, input: { approvalMode: CloudApprovalMode; expectedRevision: number }, projectId?: string) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, actor);
      if (projectId) await this.cloud.projects.authorize(c, actor, projectId, "chat");
      const current = await this.current(c, actor.organizationId, actor.memberId);
      if (current.revision !== input.expectedRevision)
        throw new IdentityError(409, "cloud_preferences_conflict", "Your approval setting changed elsewhere. Load the latest setting and try again.");
      if (current.forcedAskMe && input.approvalMode === "approveForMe")
        throw new IdentityError(409, "cloud_approval_forced", "Your organization requires Ask Me for your account.");
      if (current.approvalMode === input.approvalMode) return current;
      if (projectId) await c.query("UPDATE cloud_work_project_preferences SET approval_mode=$3,revision=revision+1 WHERE project_id=$1 AND member_id=$2", [projectId, actor.memberId, input.approvalMode]);
      else await c.query("UPDATE cloud_work_member_preferences SET approval_mode=$3,revision=revision+1,updated_at=NOW() WHERE organization_id=$1 AND member_id=$2", [actor.organizationId, actor.memberId, input.approvalMode]);
      await recordAuditEvent(c, { action: "work.cloud.approval_mode.updated", actorUserId: actor.userId,
        organizationId: actor.organizationId, metadata: { memberId: actor.memberId, ...(projectId ? { projectId } : {}), approvalMode: input.approvalMode, revision: current.revision + 1 } });
      return { ...current, approvalMode: input.approvalMode, effectiveApprovalMode: current.forcedAskMe ? "askMe" as const : input.approvalMode, revision: current.revision + 1 };
    });
  }
}
