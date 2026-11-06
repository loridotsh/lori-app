import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuditEvent } from "@lori-enterprise/contracts";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export interface AuditEventInput {
  action: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
  organizationId?: string | null;
  subjectId?: string | null;
  subjectType?: string | null;
}

export async function recordAuditEvent(
  database: Queryable,
  event: AuditEventInput,
): Promise<void> {
  await database.query(
    `
      INSERT INTO audit_events (
        id,
        action,
        actor_user_id,
        organization_id,
        subject_type,
        subject_id,
        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb
      )
    `,
    [
      randomUUID(),
      event.action,
      event.actorUserId ?? null,
      event.organizationId ?? null,
      event.subjectType ?? null,
      event.subjectId ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Spreadsheet importers can discard leading whitespace/control bytes before
  // interpreting formulas. Quoting CSV fields alone does not make them text.
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function auditEventsCsv(events: AuditEvent[]): string {
  const rows = events.map((event) =>
    [
      event.createdAt,
      event.action,
      event.actor?.name ?? "System",
      event.actor?.email ?? "",
      event.subjectType ?? "",
      event.subjectId ?? "",
      JSON.stringify(event.metadata),
    ]
      .map(csvCell)
      .join(","),
  );
  return [
    "Timestamp,Action,Actor,Actor email,Subject type,Subject ID,Metadata",
    ...rows,
  ].join("\n");
}
