import type { PoolClient } from "pg";
import { IdentityError } from "../../auth/identity-service.js";
import { openProjectValue, sealProjectValue, type ProjectKey } from "./crypto.js";

const PREFIX = "lori-project:1:";
const contexts = new WeakMap<PoolClient, ProjectKey>();
export function projectContext(c: PoolClient) { return contexts.get(c); }
export async function bindProjectContext(c: PoolClient, context: ProjectKey) {
  const old = contexts.get(c);
  if (old && (old.projectId !== context.projectId || old.organizationId !== context.organizationId))
    throw new IdentityError(403, "project_scope_mismatch", "Project scope cannot change during an operation.");
  await c.query("SELECT set_config('lori.project_id',$1,true),set_config('lori.organization_id',$2,true)", [context.projectId, context.organizationId]);
  contexts.set(c, context);
}
export function clearProjectContext(c: PoolClient) {
  const value = contexts.get(c); value?.key.fill(0); contexts.delete(c);
}
export function sealText(c: PoolClient, entity: string, id: string, field: string, value: string): string {
  const scope = projectContext(c);
  return scope ? PREFIX + Buffer.from(JSON.stringify(sealProjectValue(scope, entity, id, field, value))).toString("base64url") : value;
}
export function openText(c: PoolClient, entity: string, id: string, field: string, value: string): string {
  if (!value.startsWith(PREFIX)) {
    if (projectContext(c) && value !== "") throw new IdentityError(503, "project_plaintext_refused", "Project content is unavailable.");
    return value;
  }
  // sealText only seals inside a project, so without one this is plain text
  // that happens to start with the prefix. Refusing it would let any chat
  // message wedge the shared run queue; real ciphertext stays unreadable.
  const scope = projectContext(c);
  if (!scope) return value;
  return openProjectValue(scope, entity, id, field, JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString()));
}
export function sealJson(c: PoolClient, entity: string, id: string, field: string, value: unknown): unknown {
  const scope = projectContext(c);
  return scope ? sealProjectValue(scope, entity, id, field, value) : value;
}
export function openJson<T>(c: PoolClient, entity: string, id: string, field: string, value: T): T {
  if (!value || typeof value !== "object" || !("$project" in value)) {
    if (projectContext(c) && value != null && !(Array.isArray(value) && value.length === 0))
      throw new IdentityError(503, "project_plaintext_refused", "Project content is unavailable.");
    return value;
  }
  // As in openText: outside a project, "$project" is just someone's key.
  const scope = projectContext(c);
  if (!scope) return value;
  return openProjectValue(scope, entity, id, field, value);
}
