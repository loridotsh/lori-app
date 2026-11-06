import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { IdentityError } from "../auth/identity-service.js";
import { bytesHash } from "./files.js";
import { MAX_ACTIVE, MAX_ROWS, PREVIEW_FORMATS, PREVIEW_WINDOW, prepare, previewWorkerOnline } from "./preview-queue.js";
import type { CloudWorkService, CloudActor } from "./service.js";
import type { CloudFile } from "@lori-enterprise/contracts";
import { projectContext, openText } from "./projects/content.js";
import { previewSubject } from "./personal-projects/references.js";
import { openProjectBytes, sealProjectBytes } from "./projects/crypto.js";

export { PREVIEW_WINDOW };

const Id = z.string().uuid();
const Page = z.coerce.number().int().min(1).max(10000);
const Query = z.object({
  page: Page.default(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  retry: z.literal("true").optional(),
  /** Hold the answer up to this long until the page is ready, so the browser need not poll. */
  wait: z.coerce.number().int().min(0).max(4000).default(0),
}).strict();
const Lease = z.object({ lease: Id }).strict();
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ROOT = "/v1/work/cloud/files/:id/preview";
const REFERENCE_ROOT = "/v1/work/cloud/personal-projects/:id/references/:referenceId/preview";
const INTERNAL = "/v1/internal/work/cloud/previews";

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** A job's pages travel in one request body; a page-heavy window is split across jobs instead. */
const MAX_JOB_BYTES = 10 * 1024 * 1024;
/** The cache is disposable: bounded by rows per file, rows overall, active work, and stored bytes. */
const MAX_READY_PER_FILE = 63;
const MAX_READY_TOTAL = 320;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
/** A rendered page belongs to one immutable file version, so it stays useful for hours. */
const READY_TTL = "6 hours";
/** How often a held request looks at the row again. */
const WATCH_MS = 80;
/** The longest a worker's wait for work is held open. Shorter than the worker-seen window. */
const MAX_WORKER_WAIT_MS = 8000;

interface Row { status: string; total_pages: number | null }

/** What a page preview is rendered from: a conversation's working file or a personal project's reference. */
interface Source {
  params: z.ZodType<{ id: string; referenceId?: string }>;
  resolve: (c: PoolClient, actor: CloudActor, params: { id: string; referenceId?: string }) => Promise<CloudFile>;
}

export function registerCloudPreviewRoutes(app: FastifyInstance, cloud: CloudWorkService) {
  const files: Source = {
    params: z.object({ id: Id }).strict(),
    resolve: (c, actor, params) => cloud.files.fileTx(c, actor, params.id),
  };
  const references: Source = {
    params: z.object({ id: Id, referenceId: Id }).strict(),
    resolve: async (c, actor, params) => {
      const reference = await cloud.personalProjects.references.referenceTx(c, actor, params.referenceId!);
      if (reference.projectId !== params.id) throw new IdentityError(404, "personal_project_reference_not_found", "Reference file was not found.");
      return previewSubject(reference);
    },
  };
  const owned = async (req: FastifyRequest, source: Source) => {
    const actor = await cloud.actor(req.headers);
    await cloud.throttlePreview(actor.memberId);
    const params = source.params.parse(req.params);
    const query = Query.parse(req.query);
    const file = await cloud.transaction(async (c) => {
      await cloud.ensure(c, actor);
      return source.resolve(c, actor, params);
    });
    if (file.sha256 !== query.hash)
      throw new IdentityError(409, "cloud_file_conflict", "The file changed. Reopen it to load the current preview.");
    const scoped = <T>(who: CloudActor, subject: CloudFile, operation: (c: PoolClient) => Promise<T>) => cloud.transaction(async c => {
      await cloud.ensure(c, who);
      const current = await source.resolve(c, who, params);
      if (current.sha256 !== subject.sha256) throw new IdentityError(409, "cloud_file_conflict", "The file changed. Reopen its preview.");
      return operation(c);
    });
    return { file, query, actor, scoped };
  };
  /** A worker serving references reads owner-scoped rows under signed worker authority, never a member's identity. */
  const internalScope = (c: PoolClient) => c.query("SELECT set_config('lori.personal_scope','internal',true)");
  const workerScope = async (c: PoolClient, id: string) => {
    const scope = (await c.query<{ project_id: string; organization_id: string }>("SELECT project_id,organization_id FROM cloud_work_project_preview_queue WHERE id=$1", [id])).rows[0];
    if (scope) {
      const project = await cloud.projects.bindInternal(c, scope.organization_id, scope.project_id);
      if (project.status === "deleted") throw new IdentityError(409, "cloud_preview_lease_expired", "Project is unavailable.");
    }
  };

  /** The page count of this exact file version, once any page has been rendered. */
  const knownTotal = async (c: PoolClient, fileId: string, sha256: string): Promise<number | null> =>
    (await c.query("SELECT total_pages FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND total_pages IS NOT NULL LIMIT 1", [fileId, sha256])).rows[0]?.total_pages ?? null;

  const pageStatus = (source: Source) => async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const { file, query, actor, scoped } = await owned(req, source);
    if (!PREVIEW_FORMATS.test(file.path))
      throw new IdentityError(415, "cloud_preview_unsupported", "This format does not have a document preview.");
    const answer = (row: Row, total: number | null) => ({ status: row.status, page: query.page, totalPages: row.total_pages ?? total });
    const first = await scoped(actor, file, async (c) => {
      const select = async () => (await c.query<Row>(`SELECT status,total_pages FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND page=$3 AND (status<>'ready' OR updated_at >= NOW()-INTERVAL '${READY_TTL}')`, [file.id, file.sha256, query.page])).rows[0];
      // A finished page is the common case while scrolling: answer without taking the admission lock.
      let row = query.retry ? undefined : await select();
      if (row?.status === "ready") return answer(row, row.total_pages);
      // Serialize cache admission only, not rendering. Global and per-file caps
      // bound disk use even when many members open many pages simultaneously.
      await c.query("SELECT pg_advisory_xact_lock(732019, 32)");
      await c.query(`DELETE FROM cloud_work_file_previews WHERE (status='ready' AND updated_at < NOW()-INTERVAL '${READY_TTL}') OR (status<>'ready' AND updated_at < NOW()-INTERVAL '15 minutes')`);
      await c.query("UPDATE cloud_work_file_previews SET status='failed',lease=NULL,lease_until=NULL,updated_at=NOW() WHERE status='running' AND lease_until < NOW()");
      await c.query("UPDATE cloud_work_file_previews SET status='failed',updated_at=NOW() WHERE status='queued' AND created_at < NOW()-INTERVAL '2 minutes'");
      const total = await knownTotal(c, file.id, file.sha256);
      if (total !== null && query.page > total)
        throw new IdentityError(404, "cloud_preview_page_missing", "This document does not have that page.");
      // A retry clears the failed pages of this window so they are queued again together.
      if (query.retry) await c.query("DELETE FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND status='failed' AND page BETWEEN $3 AND $4", [file.id, file.sha256, query.page, query.page + PREVIEW_WINDOW - 1]);
      row = await select();
      if (row) {
        // A page prepared in the background that someone is now waiting for goes to the front.
        if (row.status === "queued") await c.query("UPDATE cloud_work_file_previews SET priority=0 WHERE file_id=$1 AND sha256=$2 AND status='queued' AND page BETWEEN $3 AND $4", [file.id, file.sha256, query.page, query.page + PREVIEW_WINDOW - 1]);
        return answer(row, total);
      }
      if (!(await previewWorkerOnline(c)))
        throw new IdentityError(503, "cloud_preview_unavailable", "Document preview is temporarily unavailable. You can still download this file.");
      // Drop least-recently-used finished entries; never evict active work.
      await c.query("DELETE FROM cloud_work_file_previews WHERE id IN (SELECT id FROM cloud_work_file_previews WHERE file_id=$1 AND status IN ('ready','failed') ORDER BY updated_at DESC OFFSET $2)", [file.id, MAX_READY_PER_FILE]);
      await c.query("DELETE FROM cloud_work_file_previews WHERE id IN (SELECT id FROM cloud_work_file_previews WHERE status IN ('ready','failed') ORDER BY updated_at DESC OFFSET $1)", [MAX_READY_TOTAL]);
      // The requested page plus the next few, so reading forward never waits on a fresh job.
      const last = Math.min(query.page + PREVIEW_WINDOW - 1, total ?? 10000);
      const pages = Array.from({ length: last - query.page + 1 }, (_, index) => query.page + index);
      const missing = (await c.query<{ page: number }>("SELECT n AS page FROM unnest($1::int[]) n WHERE NOT EXISTS (SELECT 1 FROM cloud_work_file_previews p WHERE p.file_id=$2 AND p.sha256=$3 AND p.page=n)", [pages, file.id, file.sha256])).rows.map((r) => r.page);
      const count = (await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status IN ('queued','running'))::int AS active FROM (SELECT status FROM cloud_work_file_previews WHERE project_id IS NULL UNION ALL SELECT status FROM cloud_work_project_preview_queue) all_previews")).rows[0]!;
      if (count.total + missing.length > MAX_ROWS || count.active + missing.length > MAX_ACTIVE)
        throw new IdentityError(429, "cloud_preview_busy", "Document previews are busy. Try again shortly.");
      for (const page of missing)
        await c.query("INSERT INTO cloud_work_file_previews(id,file_id,file_version,sha256,page,status,priority) VALUES($1,$2,$3,$4,$5,'queued',0) ON CONFLICT (file_id,sha256,page) DO NOTHING", [randomUUID(), file.id, file.version, file.sha256, page]);
      return answer({ status: "queued", total_pages: null }, total);
    });
    if (first.status === "ready" || first.status === "failed" || query.wait === 0) return first;
    // Hold the request until the page is done, so the browser learns the moment it is ready.
    const until = Date.now() + query.wait;
    let latest: Row | undefined;
    while (Date.now() < until && !req.raw.socket?.destroyed) {
      await sleep(WATCH_MS);
      latest = await scoped(actor, file, async c => (await c.query<Row>("SELECT status,total_pages FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND page=$3", [file.id, file.sha256, query.page])).rows[0]);
      if (!latest || latest.status === "ready" || latest.status === "failed") break;
    }
    // The row vanishing (retired, or refused as past the end) is answered by asking afresh.
    return latest && (latest.status === "ready" || latest.status === "failed") ? answer(latest, latest.total_pages ?? first.totalPages) : first;
  };
  const pageImage = (source: Source) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { file, query, actor, scoped } = await owned(req, source);
    const row = await scoped(actor, file, async c => {
      const page = (await c.query(`SELECT id,image,total_pages FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND page=$3 AND status='ready' AND updated_at >= NOW()-INTERVAL '${READY_TTL}'`, [file.id, file.sha256, query.page])).rows[0];
      const scope = projectContext(c);
      if (page?.image && scope) page.image = openProjectBytes(scope, "preview", page.id, "image", JSON.parse(page.image.toString("utf8")));
      return page;
    });
    if (!row?.image) throw new IdentityError(404, "cloud_preview_not_ready", "Preview is not ready.");
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "sandbox; default-src 'none'");
    // Lets the browser size the whole document from the first page without asking again.
    if (row.total_pages) reply.header("x-total-pages", String(row.total_pages));
    return reply.send(row.image);
  };
  app.get(ROOT, pageStatus(files));
  app.get(`${ROOT}/image`, pageImage(files));
  app.get(REFERENCE_ROOT, pageStatus(references));
  app.get(`${REFERENCE_ROOT}/image`, pageImage(references));
  app.post(`${INTERNAL}/claim`, async (req, reply) => {
    cloud.workerAuth(req.headers.authorization);
    const { workerId, projectScopes } = z.object({ workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), projectScopes: z.boolean().optional() }).strict().parse(req.body);
    if (workerId) await cloud.pool.query("UPDATE cloud_work_workers SET last_seen_at=NOW() WHERE id=$1", [workerId]);
    const job = await cloud.transaction(async (c) => {
      await internalScope(c);
      if (projectScopes && await cloud.projects.ready(c)) {
        const candidate = (await c.query("SELECT id FROM cloud_work_project_preview_queue WHERE status='queued' AND created_at>NOW()-INTERVAL '2 minutes' ORDER BY priority,created_at LIMIT 1")).rows[0];
        if (candidate) await workerScope(c, candidate.id);
      }
      // Members waiting first, then background preparation; each in the order it was asked for.
      const head = (await c.query("SELECT p.id,f.path,p.file_id,p.sha256,p.page FROM cloud_work_file_previews p JOIN cloud_work_preview_sources f ON f.id=p.file_id AND f.sha256=p.sha256 WHERE p.project_id IS NOT DISTINCT FROM $1::uuid AND p.status='queued' AND p.created_at > NOW()-INTERVAL '2 minutes' ORDER BY p.priority, p.created_at, p.page FOR UPDATE OF p SKIP LOCKED LIMIT 1", [projectContext(c)?.projectId ?? null])).rows[0];
      if (!head) return null;
      // Take the queued pages that directly follow, so one staged copy and one conversion serves them all.
      const following = (await c.query<{ id: string; page: number }>("SELECT id,page FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND status='queued' AND page > $3 AND page < $3+$4 ORDER BY page FOR UPDATE SKIP LOCKED", [head.file_id, head.sha256, head.page, PREVIEW_WINDOW])).rows;
      const ids = [head.id];
      for (const next of following) {
        if (next.page !== head.page + ids.length) break;
        ids.push(next.id);
      }
      const lease = randomUUID();
      await c.query("UPDATE cloud_work_file_previews SET status='running',lease=$2,lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW() WHERE id=ANY($1::uuid[])", [ids, lease]);
      return { id: head.id, lease, path: openText(c, "file", head.file_id, "path", head.path), fileId: head.file_id, sha256: head.sha256, page: head.page, count: ids.length, ...(projectContext(c) ? { projectId: projectContext(c)!.projectId } : {}) };
    });
    return job ?? reply.code(204).send();
  });
  /**
   * A worker waits here instead of polling: the answer comes the moment a page is queued
   * (200), or after a few seconds with nothing to do (204). Nothing is leased.
   */
  app.post(`${INTERNAL}/wait`, async (req, reply) => {
    cloud.workerAuth(req.headers.authorization);
    const { workerId, waitMs } = z.object({
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
      waitMs: z.number().int().min(0).max(MAX_WORKER_WAIT_MS).default(MAX_WORKER_WAIT_MS),
    }).strict().parse(req.body ?? {});
    if (workerId) await cloud.pool.query("UPDATE cloud_work_workers SET last_seen_at=NOW() WHERE id=$1", [workerId]);
    const until = Date.now() + waitMs;
    for (;;) {
      // The same test the claim applies, so a page the worker could not take never wakes it.
      const found = await cloud.transaction(async (c) => {
        await internalScope(c);
        return c.query("SELECT 1 FROM cloud_work_file_previews p JOIN cloud_work_preview_sources f ON f.id=p.file_id AND f.sha256=p.sha256 WHERE p.status='queued' AND p.created_at > NOW()-INTERVAL '2 minutes' UNION ALL SELECT 1 FROM cloud_work_project_preview_queue WHERE status='queued' AND created_at>NOW()-INTERVAL '2 minutes' LIMIT 1");
      });
      if (found.rowCount) return { queued: true };
      if (Date.now() >= until || req.raw.socket?.destroyed) return reply.code(204).send();
      await sleep(Math.min(WATCH_MS * 2, Math.max(1, until - Date.now())));
    }
  });
  const leased = async (req: FastifyRequest, c: PoolClient) => {
    cloud.workerAuth(req.headers.authorization);
    const { id } = z.object({ id: Id }).strict().parse(req.params);
    const { lease } = Lease.parse(req.query);
    await workerScope(c, id);
    await internalScope(c);
    const row = (await c.query("SELECT p.*,v.storage_key FROM cloud_work_file_previews p JOIN cloud_work_preview_sources f ON f.id=p.file_id AND f.sha256=p.sha256 JOIN cloud_work_preview_source_versions v ON v.file_id=p.file_id AND v.version=p.file_version WHERE p.id=$1 AND p.lease=$2 AND p.status='running' AND p.lease_until>NOW()", [id, lease])).rows[0];
    if (!row) throw new IdentityError(409, "cloud_preview_lease_expired", "Preview lease expired or file changed.");
    return row;
  };
  app.get(`${INTERNAL}/:id/input`, async (req, reply) => {
    const bytes = await cloud.transaction(async c => {
      const row = await leased(req, c), bytes = await cloud.files.stagedBytes(row.storage_key, c);
      if (bytesHash(bytes) !== row.sha256) throw new IdentityError(503, "cloud_preview_source_invalid", "Preview source integrity check failed.");
      return bytes;
    });
    reply.header("content-type", "application/octet-stream");
    return reply.send(bytes);
  });
  const Rendered = z.object({ page: z.number().int().min(1).max(10000), image: z.string().min(1).max(5592408) }).strict();
  app.post(`${INTERNAL}/:id/complete`, { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const row = await cloud.transaction(c => leased(req, c));
    const body = z.discriminatedUnion("status", [
      z.object({ status: z.literal("failed") }).strict(),
      z.object({
        status: z.literal("ready"),
        totalPages: z.number().int().min(1).max(100000),
        // `image` is the single-page form older workers send for the job's first page.
        image: z.string().min(1).max(5592408).optional(),
        pages: z.array(Rendered).min(1).max(PREVIEW_WINDOW).optional(),
      }).strict().refine((value) => (value.image === undefined) !== (value.pages === undefined)),
    ]).parse(req.body);
    const group = await cloud.transaction(async c => { await leased(req, c); return (await c.query<{ id: string; page: number }>("SELECT id,page FROM cloud_work_file_previews WHERE file_id=$1 AND sha256=$2 AND lease=$3 AND status='running' AND lease_until>NOW() ORDER BY page", [row.file_id, row.sha256, row.lease])).rows; });
    const invalid = () => new IdentityError(400, "cloud_preview_image_invalid", "Invalid preview page.");
    let rendered: { id: string; page: number; image: Buffer }[] = [];
    if (body.status === "ready") {
      const supplied = body.pages ?? [{ page: row.page, image: body.image! }];
      const owners = new Map(group.map((item) => [item.page, item.id]));
      let bytes = 0;
      rendered = supplied.map((item) => {
        const image = Buffer.from(item.image, "base64");
        bytes += image.length;
        if (!owners.has(item.page) || item.page > body.totalPages || image.length > MAX_PAGE_BYTES || bytes > MAX_JOB_BYTES || !image.subarray(0, 8).equals(PNG)) throw invalid();
        return { id: owners.get(item.page)!, page: item.page, image };
      });
      if (new Set(rendered.map((item) => item.page)).size !== rendered.length || !rendered.some((item) => item.page === row.page)) throw invalid();
    }
    const outcome = await cloud.transaction(async (c) => {
      await leased(req, c);
      // Re-check under the same fence: the lease, the lease window and the file version.
      const current = (await c.query<{ id: string; page: number }>("SELECT p.id,p.page FROM cloud_work_file_previews p WHERE p.file_id=$1 AND p.sha256=$2 AND p.lease=$3 AND p.status='running' AND p.lease_until>NOW() AND EXISTS(SELECT 1 FROM cloud_work_preview_sources f WHERE f.id=p.file_id AND f.sha256=p.sha256) FOR UPDATE OF p", [row.file_id, row.sha256, row.lease])).rows;
      if (!current.some((item) => item.id === row.id)) return false;
      if (body.status === "failed") {
        await c.query("UPDATE cloud_work_file_previews SET status='failed',total_pages=NULL,image=NULL,lease=NULL,lease_until=NULL,updated_at=NOW() WHERE id=ANY($1::uuid[])", [current.map((item) => item.id)]);
        return true;
      }
      const cacheBytes = Number((await c.query("SELECT COALESCE(sum(bytes),0) AS total FROM (SELECT octet_length(image) AS bytes FROM cloud_work_file_previews WHERE project_id IS NULL AND status='ready' UNION ALL SELECT image_bytes AS bytes FROM cloud_work_project_preview_queue WHERE status='ready') cached")).rows[0].total);
      const incomingBytes = rendered.reduce((sum, item) => sum + (projectContext(c) ? Math.ceil(item.image.length * 4 / 3) + 256 : item.image.length), 0);
      if (cacheBytes + incomingBytes > MAX_CACHE_BYTES) {
        await c.query("UPDATE cloud_work_file_previews SET status='failed',image=NULL,lease=NULL,lease_until=NULL,updated_at=NOW() WHERE id=ANY($1::uuid[])", [current.map(item => item.id)]);
        return true;
      }
      const done = new Set(rendered.map((item) => item.id));
      for (const item of rendered)
        await c.query("UPDATE cloud_work_file_previews SET status='ready',total_pages=$2,image=$3,lease=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1", [item.id, body.totalPages, projectContext(c) ? Buffer.from(JSON.stringify(sealProjectBytes(projectContext(c)!, "preview", item.id, "image", item.image))) : item.image]);
      // Pages past the end never existed; pages the worker left out are queued again.
      const past = current.filter((item) => !done.has(item.id) && item.page > body.totalPages).map((item) => item.id);
      const again = current.filter((item) => !done.has(item.id) && item.page <= body.totalPages).map((item) => item.id);
      if (past.length) await c.query("DELETE FROM cloud_work_file_previews WHERE id=ANY($1::uuid[])", [past]);
      if (again.length) await c.query("UPDATE cloud_work_file_previews SET status='queued',lease=NULL,lease_until=NULL,created_at=NOW(),updated_at=NOW() WHERE id=ANY($1::uuid[])", [again]);
      // Keep the newest finished pages within the byte budget.
      await c.query("DELETE FROM cloud_work_file_previews WHERE id IN (SELECT id FROM (SELECT id,sum(octet_length(image)) OVER (ORDER BY updated_at DESC, id) AS running FROM cloud_work_file_previews WHERE status='ready') kept WHERE running > $1)", [MAX_CACHE_BYTES]);
      // Read ahead: the pages after this window are prepared now, while the member reads this one.
      const storedPath = (await c.query<{ path: string }>("SELECT path FROM cloud_work_preview_sources WHERE id=$1", [row.file_id])).rows[0]?.path;
      const path = storedPath ? openText(c, "file", row.file_id, "path", storedPath) : undefined;
      const furthest = Math.max(...rendered.map((item) => item.page), 0);
      if (path && furthest) await prepare(c, { id: row.file_id, version: row.file_version, sha256: row.sha256, path }, { from: furthest + 1, total: body.totalPages });
      return true;
    });
    if (!outcome) throw new IdentityError(409, "cloud_preview_lease_expired", "Preview lease expired or file changed.");
    return { ok: true };
  });
}
