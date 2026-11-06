import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IdentityError } from "../auth/identity-service.js";
import type { CloudActor, CloudWorkService } from "./service.js";

type Row = { id: string; run_id: string; conversation_id: string; project_id: string | null; approval_id: string | null; kind: string; created_at: Date };
const querySchema = z.object({
  since: z.iso.datetime({ offset: true }),
  before: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n).optional(),
}).strict();

export async function notifications(cloud: CloudWorkService, actor: CloudActor, query: z.infer<typeof querySchema>) {
  // The directory contains no titles, message text, tool arguments or errors.
  // Every returned event is reauthorized against the resource in its own scope.
  const page = await cloud.transaction(async c => {
    await cloud.ensure(c, actor);
    await c.query("DELETE FROM cloud_work_notifications WHERE organization_id=$1 AND member_id=$2 AND created_at < NOW()-INTERVAL '24 hours'", [actor.organizationId, actor.memberId]);
    const serverTime = (await c.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
    const rows = (await c.query<Row>(`SELECT id::text,run_id,conversation_id,project_id,approval_id,kind,created_at FROM cloud_work_notifications
      WHERE organization_id=$1 AND member_id=$2 AND created_at >= GREATEST($3::timestamptz,NOW()-INTERVAL '24 hours')
      AND ($4::bigint IS NULL OR id<$4::bigint) ORDER BY id DESC LIMIT 101`, [actor.organizationId, actor.memberId, query.since, query.before ?? null])).rows;
    return { rows, serverTime };
  });
  const events: { id: string; runId: string; conversationId: string; projectId: string | null; approvalId: string | null; kind: string; createdAt: string }[] = [];
  const groups = new Map<string | null, Row[]>();
  for (const event of page.rows.slice(0, 100)) groups.set(event.project_id, [...groups.get(event.project_id) ?? [], event]);
  for (const [project, candidates] of groups) {
    try {
      const current = await cloud.transaction(async c => {
        await cloud.ensure(c, actor);
        if (project) await cloud.projects.authorize(c, actor, project, "read");
        return (await c.query<Row>(`SELECT n.id::text,n.run_id,n.conversation_id,n.project_id,n.approval_id,n.kind,n.created_at
          FROM cloud_work_notifications n JOIN cloud_work_runs r ON r.id=n.run_id AND r.conversation_id=n.conversation_id
          JOIN cloud_work_conversations conv ON conv.id=r.conversation_id
          LEFT JOIN cloud_work_approvals a ON a.id=n.approval_id AND a.run_id=r.id
          WHERE n.id=ANY($1::bigint[]) AND n.organization_id=$2 AND n.member_id=$3
            AND r.organization_id=$2 AND r.member_id=$3
            AND (conv.personal_project_id IS NULL OR EXISTS(SELECT 1 FROM cloud_work_personal_projects pp WHERE pp.id=conv.personal_project_id AND pp.organization_id=$2 AND pp.member_id=$3 AND pp.status<>'deleted'))
            AND ((n.kind='approval' AND r.status='awaitingApproval' AND a.status='pending') OR (n.kind<>'approval' AND r.status=n.kind))`,
          [candidates.map(event => event.id), actor.organizationId, actor.memberId])).rows;
      });
      for (const event of current) events.push({ id: event.id, runId: event.run_id, conversationId: event.conversation_id, projectId: event.project_id, approvalId: event.approval_id, kind: event.kind, createdAt: event.created_at.toISOString() });
    } catch (error) {
      if (!(error instanceof IdentityError && ([403, 404].includes(error.statusCode) || project && error.code === "projects_unavailable"))) throw error;
    }
  }
  events.sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
  return { recipient: { organizationId: actor.organizationId, userId: actor.userId }, events, serverTime: page.serverTime, nextCursor: page.rows.length > 100 ? page.rows[99]!.id : null };
}

export function registerNotificationRoutes(app: FastifyInstance, cloud: CloudWorkService) {
  app.get("/v1/work/cloud/notifications", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const actor = await cloud.actor(request.headers);
    return notifications(cloud, actor, querySchema.parse(request.query));
  });
}
