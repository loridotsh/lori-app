import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { openJson, openText } from "./content.js";

type Kind = "tool" | "approval" | "round" | "staged" | "connection";
const fields: Record<Kind, readonly string[]> = {
  tool: ["arguments", "execution", "output", "model_output"],
  approval: ["files"], round: ["assistant", "tool_calls"], staged: [],
  connection: ["tools", "resources"],
};
/** Explicit repository read adapter. SQL and authorization remain at the call site. */
export async function readContent<T extends QueryResultRow>(c: PoolClient, kind: Kind, operation: Promise<QueryResult<T>>): Promise<QueryResult<T>> {
  const result = await operation;
  result.rows = result.rows.map(row => {
    const decoded: QueryResultRow = { ...row };
    const id = String(kind === "staged" ? row.storage_key : row.id);
    for (const field of fields[kind]) if (decoded[field] != null) decoded[field] = openJson(c, kind, id, field, decoded[field]);
    if (kind === "approval" && typeof decoded.summary === "string") decoded.summary = openText(c, kind, id, "summary", decoded.summary);
    if (kind === "staged" && typeof decoded.path === "string") decoded.path = openText(c, kind, id, "path", decoded.path);
    return decoded as T;
  });
  return result;
}
