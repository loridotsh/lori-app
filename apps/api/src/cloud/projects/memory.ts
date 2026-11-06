import type { PoolClient } from "pg";
import type { ProjectMemory } from "@lori-enterprise/contracts";
import { IdentityError } from "../../auth/identity-service.js";
import { recordAuditEvent } from "../../auth/audit.js";
import type { CloudActor, CloudWorkService } from "../service.js";
import { secretLike } from "../memory.js";
import { projectContext } from "./content.js";
import { sealProjectValue, openProjectValue } from "./crypto.js";
import { bestScore, fingerprint, fuse, manifest, type Probe } from "../semantic/ranking.js";

export interface ProjectMemoryInput { topic: string; content: string; sensitive?: boolean; sourceMessageId?: string }
export class ProjectMemoryStore {
  constructor(private cloud: CloudWorkService) {}
  async authorize(c: PoolClient, a: CloudActor, projectId: string, write = false) {
    const access = await this.cloud.projects.authorize(c, a, projectId, write ? "memory.write" : "read");
    const policy = await this.cloud.workPolicy(a.organizationId, a.memberId, c);
    if (!policy.memoryAllowed || !access.row.policy.memoryEnabled)
      throw new IdentityError(403, "project_memory_disabled", "Project memory is disabled.");
    return access;
  }
  private note(c: PoolClient, r: Record<string, unknown>): ProjectMemory {
    const value = openProjectValue<{ topic: string; content: string }>(projectContext(c)!, "memory", String(r.id), "content", r.content);
    return { id: String(r.id), ...value, sensitive: Boolean(r.sensitive) || secretLike(value.topic) || secretLike(value.content), revision: Number(r.revision), sourceMessageId: r.source_message_id as string | null, provenance: r.provenance as ProjectMemory["provenance"], createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString() };
  }
  async listTx(c: PoolClient, a: CloudActor, projectId: string, model = false, query = "", probe: Probe | null = null) {
    await this.authorize(c, a, projectId);
    const rows = (await c.query("SELECT * FROM cloud_work_project_memory WHERE project_id=$1 ORDER BY updated_at DESC,id LIMIT 200", [projectId])).rows;
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const notes = rows.map(r => this.note(c, r)).filter(n => !model || !n.sensitive);
    const matches = notes.filter(n => !words.length || words.some(w => `${n.topic} ${n.content}`.toLocaleLowerCase().includes(w)));
    if (!probe || !words.length) return matches;
    const byId = new Map(notes.map(n => [n.id, n]));
    return fuse([matches.map(n => n.id), await this.semanticIds(c, projectId, notes, probe)]).map(id => byId.get(id)!);
  }
  /**
   * Ranks project notes by the encrypted semantic index. A vector counts only while
   * its fingerprint still matches the note's current text; stale vectors are ignored.
   */
  async semanticIds(c: PoolClient, projectId: string, notes: { id: string; topic: string; content: string; sensitive: boolean }[], probe: Probe) {
    const payload = await this.cloud.projectRetrieval.vectorsTx(c, projectId);
    if (!payload) return [];
    const ranked: [string, number][] = [];
    for (const n of notes) {
      const doc = payload.docs[n.id];
      if (n.sensitive || !doc || doc.fp !== fingerprint(n.topic, n.content)) continue;
      const best = bestScore(probe, doc.chunks);
      if (best >= probe.floor) ranked.push([n.id, best]);
    }
    return ranked.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, manifest.candidates).map(([id]) => id);
  }
  async readTx(c: PoolClient, a: CloudActor, projectId: string, id: string, model = false) {
    await this.authorize(c, a, projectId);
    const row = (await c.query("SELECT * FROM cloud_work_project_memory WHERE id=$1 AND project_id=$2", [id, projectId])).rows[0];
    if (!row) throw new IdentityError(404, "project_memory_not_found", "Memory was not found.");
    const note = this.note(c, row);
    if (model && note.sensitive) throw new IdentityError(404, "project_memory_not_found", "Memory was not found.");
    return note;
  }
  async saveTx(c: PoolClient, a: CloudActor, projectId: string, id: string, input: ProjectMemoryInput, expectedRevision?: number, provenance: "manual" | "approved_tool" = "manual") {
    await this.authorize(c, a, projectId, true);
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-memory:${projectId}`]);
    if (secretLike(input.topic) || secretLike(input.content)) throw new IdentityError(400, "project_memory_secret", "Do not store credentials in project memory.");
    if (provenance === "approved_tool" && input.sensitive) throw new IdentityError(400, "project_memory_sensitive", "Sensitive memory must be saved manually.");
    if (input.sourceMessageId && !(await c.query("SELECT 1 FROM cloud_work_messages WHERE id=$1 AND project_id=$2", [input.sourceMessageId, projectId])).rowCount)
      throw new IdentityError(404, "project_memory_source", "The source does not belong to this project.");
    const rows = (await c.query("SELECT * FROM cloud_work_project_memory WHERE project_id=$1 ORDER BY id FOR UPDATE", [projectId])).rows;
    const old = rows.find(r => r.id === id);
    if (old && expectedRevision === undefined) {
      const prior = this.note(c, old);
      if (prior.topic === input.topic && prior.content === input.content && prior.sensitive === !!input.sensitive && prior.sourceMessageId === (input.sourceMessageId ?? null)) return prior;
      throw new IdentityError(409, "project_memory_conflict", "The memory request changed.");
    }
    if (expectedRevision !== undefined && (!old || old.revision !== expectedRevision)) throw new IdentityError(409, "project_memory_conflict", "Memory changed. Reload before saving.");
    const bytes = rows.filter(r => r.id !== id).reduce((sum, r) => sum + Buffer.byteLength(this.note(c, r).content), 0) + Buffer.byteLength(input.content);
    if ((!old && rows.length >= 200) || bytes > 1048576) throw new IdentityError(413, "project_memory_limit", "Project memory has reached its storage limit.");
    const content = sealProjectValue(projectContext(c)!, "memory", id, "content", { topic: input.topic, content: input.content });
    const row = (await c.query("INSERT INTO cloud_work_project_memory(id,project_id,organization_id,content,sensitive,author_id,source_message_id,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,sensitive=EXCLUDED.sensitive,revision=cloud_work_project_memory.revision+1,source_message_id=EXCLUDED.source_message_id,provenance=EXCLUDED.provenance,updated_at=NOW() RETURNING *", [id, projectId, a.organizationId, JSON.stringify(content), !!input.sensitive, a.memberId, input.sourceMessageId ?? null, provenance])).rows[0]!;
    await this.cloud.projects.invalidate(c, projectId);
    await recordAuditEvent(c, { action: "work.project.memory.saved", organizationId: a.organizationId, actorUserId: a.userId, subjectType: "project_memory", subjectId: id, metadata: { projectId, revision: row.revision } });
    return this.note(c, row);
  }
  async remove(a: CloudActor, projectId: string, id: string, revision: number) {
    return this.cloud.transaction(async c => {
      await this.cloud.ensure(c, a); await this.cloud.projects.authorize(c, a, projectId, "memory.delete");
      const removed = await c.query("DELETE FROM cloud_work_project_memory WHERE id=$1 AND project_id=$2 AND revision=$3", [id, projectId, revision]);
      if (!removed.rowCount) throw new IdentityError(409, "project_memory_conflict", "Memory changed. Reload before deleting.");
      await this.cloud.projects.invalidate(c, projectId);
      await recordAuditEvent(c, { action: "work.project.memory.deleted", organizationId: a.organizationId, actorUserId: a.userId, subjectType: "project_memory", subjectId: id, metadata: { projectId } });
    });
  }
}
