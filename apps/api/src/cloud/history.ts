import type { PoolClient } from "pg";
import type { CloudMessage, CloudFile } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
import { openText } from "./projects/content.js";

const RAW_PAGE_BYTES = 512 * 1024;
const JSON_PAGE_BYTES = 1024 * 1024;
type MessageRow = { project_id: string | null; author_id: string | null; author_name: string | null; id: string; run_id: string; role: CloudMessage["role"]; run_status: CloudMessage["runStatus"]; attachment_ids: string[]; text: string; created_at: Date };

/** Caller owns the conversation. Bound transferred text before PostgreSQL returns it,
 * then account for JSON escaping too. A single large message remains complete.
 */
export async function historyPage(c: PoolClient, conversationId: string, files: CloudFile[], before?: string) {
  let anchor: { id: string; created_at: Date } | undefined;
  if (before) {
    anchor = (await c.query<{ id: string; created_at: Date }>("SELECT id,created_at FROM cloud_work_messages WHERE conversation_id=$1 AND id=$2", [conversationId, before])).rows[0];
    if (!anchor) throw new IdentityError(404, "cloud_history_cursor_invalid", "The history cursor does not belong to this conversation.");
  }
  const rows = await c.query<MessageRow>(
    `WITH recent AS (
      SELECT * FROM cloud_work_messages WHERE conversation_id=$1
        ${anchor ? "AND (created_at,id)<(SELECT created_at,id FROM cloud_work_messages WHERE conversation_id=$1 AND id=$2)" : ""}
      ORDER BY created_at DESC,id DESC LIMIT 100
    ), sized AS (
      SELECT recent.*,SUM(octet_length(text)) OVER (ORDER BY created_at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS bytes,
        row_number() OVER (ORDER BY created_at DESC,id DESC) AS position FROM recent
    ) SELECT sized.*,r.status AS run_status,u.name AS author_name FROM sized JOIN cloud_work_runs r ON r.id=sized.run_id LEFT JOIN member m ON m.id=sized.author_id LEFT JOIN "user" u ON u.id=m."userId"
      WHERE bytes<=${RAW_PAGE_BYTES} OR position=1 ORDER BY sized.created_at DESC,sized.id DESC`,
    anchor ? [conversationId, anchor.id] : [conversationId],
  );
  const messages: CloudMessage[] = [];
  let bytes = 0;
  for (const row of rows.rows) {
    const message: CloudMessage = { ...(row.project_id && row.role === "user" ? { author: { memberId: row.author_id, name: row.author_name ?? "Former member" } } : {}), id: row.id, runId: row.run_id, runStatus: row.run_status, role: row.role, text: openText(c, "message", row.id, "text", row.text), createdAt: row.created_at.toISOString(),
      attachments: (row.attachment_ids ?? []).map(id => files.find(file => file.id === id)).filter((file): file is CloudFile => !!file) };
    const size = Buffer.byteLength(JSON.stringify(message));
    if (messages.length && bytes + size > JSON_PAGE_BYTES) break;
    messages.push(message); bytes += size;
  }
  const oldest = messages.at(-1);
  const more = oldest ? (await c.query<{ more: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM cloud_work_messages WHERE conversation_id=$1 AND (created_at,id)<(SELECT created_at,id FROM cloud_work_messages WHERE id=$2 AND conversation_id=$1)) AS more",
    [conversationId, oldest.id],
  )).rows[0]!.more : false;
  return { messages: messages.reverse(), historyCursor: more ? oldest!.id : null };
}
