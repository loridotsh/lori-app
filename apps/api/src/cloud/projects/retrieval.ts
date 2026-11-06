import MiniSearch from "minisearch";
import type { PoolClient } from "pg";
import type { ProjectSource } from "@lori-enterprise/contracts";
import type { CloudActor, CloudWorkService } from "../service.js";
import { openText, projectContext } from "./content.js";
import { openProjectValue, sealProjectValue } from "./crypto.js";
import { bestScore, encodeChunks, fingerprint, fuse, manifest } from "../semantic/ranking.js";

type Document = ProjectSource & { text: string; fp: string };
type Vectors = { model: string; docs: Record<string, { fp: string; chunks: ReturnType<typeof encodeChunks> }> };
const OPTIONS = { fields: ["title", "text"], storeFields: ["kind", "title", "excerpt", "conversationId", "fileId", "version", "fp"] };
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENTS = 4000;
const EMBED_BUDGET_MS = 10_000;
/** Encrypted snapshots; plaintext exists only in a bounded, request-local index. */
export class ProjectRetrieval {
  /** Process-local embeddings of unchanged documents, so an interrupted build is not repeated. */
  private embedded = new Map<string, Vectors["docs"][string]>();
  constructor(private cloud: CloudWorkService) {}
  /** The sealed semantic index for the bound project, or null when absent, stale-model or unreadable. */
  async vectorsTx(c: PoolClient, projectId: string): Promise<Vectors | null> {
    const row = (await c.query("SELECT vectors FROM cloud_work_project_search WHERE project_id=$1", [projectId])).rows[0];
    if (!row?.vectors) return null;
    try {
      const payload = openProjectValue<Vectors>(projectContext(c)!, "search", projectId, "vectors", row.vectors);
      return payload.model === manifest.id ? payload : null;
    } catch { return null; }
  }
  async searchTx(c: PoolClient, a: CloudActor, projectId: string, query: string): Promise<{ sources: ProjectSource[]; status: string }> {
    await this.cloud.projectMemory.authorize(c, a, projectId);
    const saved = (await c.query("SELECT * FROM cloud_work_project_search WHERE project_id=$1", [projectId])).rows[0];
    if (!saved?.snapshot || Number(saved.indexed_revision) !== Number(saved.revision)) return { sources: [], status: saved?.status ?? "pending" };
    const json = openProjectValue<string>(projectContext(c)!, "search", projectId, "snapshot", saved.snapshot);
    if (Buffer.byteLength(json) > MAX_INDEX_BYTES) return { sources: [], status: "limited" };
    const index = MiniSearch.loadJSON<Document>(json, OPTIONS);
    const lexical = index.search(query.slice(0, 500), { prefix: true, fuzzy: 0.15, boost: { title: 2 } }).slice(0, manifest.candidates).map(hit => String(hit.id));
    const probe = this.cloud.semantic.peek(query);
    const similar: [string, number][] = [];
    const vectors = probe ? await this.vectorsTx(c, projectId) : null;
    if (probe && vectors)
      for (const [id, doc] of Object.entries(vectors.docs)) {
        // A vector is used only for the exact document text the current snapshot holds.
        if (index.getStoredFields(id)?.fp !== doc.fp) continue;
        const best = bestScore(probe, doc.chunks);
        if (best >= probe.floor) similar.push([id, best]);
      }
    similar.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const ranked = fuse([lexical, similar.slice(0, manifest.candidates).map(([id]) => id)]).slice(0, 12);
    const sources: ProjectSource[] = [];
    for (const id of ranked) {
      const hit = index.getStoredFields(id) as Record<string, string | number | undefined> | undefined;
      if (!hit) continue;
      const source = { id, kind: hit.kind, title: hit.title, excerpt: hit.excerpt, ...(hit.conversationId ? { conversationId: hit.conversationId } : {}), ...(hit.fileId ? { fileId: hit.fileId, version: hit.version } : {}) } as ProjectSource;
      let valid = false;
      if (source.kind === "file") valid = !!(await c.query("SELECT 1 FROM cloud_work_files WHERE id=$1 AND project_id=$2 AND version=$3", [source.fileId, projectId, source.version])).rowCount;
      else if (source.kind === "message") valid = !!(await c.query("SELECT 1 FROM cloud_work_messages WHERE id=$1 AND project_id=$2", [source.id, projectId])).rowCount;
      else valid = !!(await c.query("SELECT 1 FROM cloud_work_project_memory WHERE id=$1 AND project_id=$2 AND NOT sensitive", [source.id, projectId])).rowCount;
      if (valid) sources.push(source);
    }
    return { sources, status: saved.status };
  }
  async rebuild(organizationId: string, projectId: string) {
    const semantic = this.cloud.semantic.available;
    const plan = await this.cloud.transaction(async c => {
      const project = await this.cloud.projects.bindInternal(c, organizationId, projectId);
      if (project.status !== "active" || !project.policy.memoryEnabled) return null;
      // Do not block foreground edits while another indexer owns the project.
      if (!(await c.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [`project-search:${projectId}`])).rows[0]?.locked) return null;
      const row = (await c.query("SELECT * FROM cloud_work_project_search WHERE project_id=$1", [projectId])).rows[0];
      const lexicalReady = row?.status === "ready" && row.indexed_revision === row.revision;
      if (!row || lexicalReady && (!semantic || Number(row.semantic_revision) === Number(row.revision))) return null;
      const docs: Document[] = [];
      let size = 0, limited = false;
      const add = (doc: Omit<Document, "fp">) => { const full = { ...doc, fp: fingerprint(doc.title, doc.text) }; const bytes = Buffer.byteLength(JSON.stringify(full)); if (docs.length >= MAX_DOCUMENTS || size + bytes > 4 * 1024 * 1024) { limited = true; return; } docs.push(full); size += bytes; };
      const messages = (await c.query("SELECT m.id,m.conversation_id,m.text,c.title FROM cloud_work_messages m JOIN cloud_work_conversations c ON c.id=m.conversation_id WHERE m.project_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT $2", [projectId, MAX_DOCUMENTS + 1])).rows;
      for (const m of messages) {
        const text = openText(c, "message", m.id, "text", m.text);
        const title = openText(c, "conversation", m.conversation_id, "title", m.title);
        add({ id: m.id, kind: "message", title, conversationId: m.conversation_id, text: text.slice(0, 8000), excerpt: text.slice(0, 1500) });
        if (text.length > 8000) limited = true;
      }
      const memories = (await c.query("SELECT * FROM cloud_work_project_memory WHERE project_id=$1 AND NOT sensitive ORDER BY updated_at DESC", [projectId])).rows;
      for (const m of memories) { const note = openProjectValue<{ topic: string; content: string }>(projectContext(c)!, "memory", m.id, "content", m.content); add({ id: m.id, kind: "memory", title: note.topic, text: note.content, excerpt: note.content.slice(0, 1500) }); }
      const files = await this.cloud.files.listTx(c, projectId);
      for (const file of files) {
        let text = "";
        if (/\.(txt|md|csv|tsv|json|xml|html|log)$/i.test(file.path) && file.sizeBytes <= 262144) {
          try { text = this.cloud.files.decode(await this.cloud.files.readTx(c, file)); } catch { limited = true; }
        } else limited = true; // Binary files remain available through document tools, not a pretend text index.
        add({ id: `file:${file.id}`, kind: "file", title: file.path, fileId: file.id, version: file.version, text: text.slice(0, 8000), excerpt: text.slice(0, 1500) });
        if (text.length > 8000) limited = true;
      }
      if (!lexicalReady || !row.snapshot || semantic) {
        const index = new MiniSearch<Document>(OPTIONS); index.addAll(docs);
        let snapshot = JSON.stringify(index);
        if (Buffer.byteLength(snapshot) > MAX_INDEX_BYTES) { index.removeAll(); snapshot = JSON.stringify(index); limited = true; }
        await c.query("UPDATE cloud_work_project_search SET snapshot=$2,indexed_revision=$3,status=$4,updated_at=NOW() WHERE project_id=$1 AND revision=$3", [projectId, JSON.stringify(sealProjectValue(projectContext(c)!, "search", projectId, "snapshot", snapshot)), row.revision, limited ? "limited" : "ready"]);
      }
      if (!semantic) return null;
      const previous = await this.vectorsTx(c, projectId);
      for (const [id, doc] of Object.entries(previous?.docs ?? {})) this.embedded.set(`${projectId}:${id}:${doc.fp}`, doc);
      return { revision: Number(row.revision), docs: docs.filter(d => d.text.trim()).map(d => ({ id: d.id, fp: d.fp, title: d.title, text: d.text })) };
    });
    if (!plan) return;
    // Inference runs outside every transaction; the publish below re-checks the revision.
    const started = Date.now();
    const out: Vectors["docs"] = {};
    let complete = true;
    for (const doc of plan.docs) {
      const key = `${projectId}:${doc.id}:${doc.fp}`;
      let cached = this.embedded.get(key);
      if (!cached && Date.now() - started < EMBED_BUDGET_MS) {
        const chunks = await this.cloud.semantic.passage(doc.title, doc.text);
        if (chunks) { cached = { fp: doc.fp, chunks: encodeChunks(chunks) }; this.embedded.set(key, cached); }
      }
      if (cached) out[doc.id] = cached; else complete = false;
    }
    while (this.embedded.size > 50_000) this.embedded.delete(this.embedded.keys().next().value!);
    await this.cloud.transaction(async c => {
      const project = await this.cloud.projects.bindInternal(c, organizationId, projectId);
      if (project.status !== "active" || !project.policy.memoryEnabled) return;
      const row = (await c.query("SELECT revision FROM cloud_work_project_search WHERE project_id=$1 FOR UPDATE", [projectId])).rows[0];
      // A changed project may have removed documents; never republish their derived vectors.
      if (!row || Number(row.revision) !== plan.revision) return;
      const payload: Vectors = { model: manifest.id, docs: out };
      await c.query("UPDATE cloud_work_project_search SET vectors=$2,semantic_revision=CASE WHEN $3 THEN revision ELSE semantic_revision END WHERE project_id=$1", [projectId, JSON.stringify(sealProjectValue(projectContext(c)!, "search", projectId, "vectors", payload)), complete]);
    });
  }
}
