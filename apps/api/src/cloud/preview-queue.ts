import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Pages rendered by one worker job. Converting an Office file is most of the work and a job does it
 * once, while a page costs a few tens of milliseconds, so a window is generous.
 */
export const PREVIEW_WINDOW = 8;
/** Pages prepared before anyone asks, per document version: the first screens of reading. */
export const PREPARE_PAGES = 24;
/** Formats that open as page images. Workbooks open as a live sheet and are prepared only on request. */
export const PREPARED_FORMATS = /\.(pdf|docx|pptx|doc|ppt|odt|odp)$/i;
export const PREVIEW_FORMATS = /\.(pdf|docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/i;

/** Queue limits. Background work stops well short of the ceiling so a member waiting is never refused. */
export const MAX_ROWS = 384;
export const MAX_ACTIVE = 64;
const MAX_BACKGROUND_ACTIVE = 24;

/** True when a worker able to render previews was seen recently. */
export async function previewWorkerOnline(c: PoolClient): Promise<boolean> {
  const worker = await c.query("SELECT 1 FROM cloud_work_workers WHERE last_seen_at > NOW()-INTERVAL '15 seconds' AND capabilities->>'documentPreviews'='true' LIMIT 1");
  return (worker.rowCount ?? 0) > 0;
}

/**
 * Queues background renders of a document's pages. Never throws and never blocks the caller's
 * transaction: any failure rolls back to a savepoint and the member simply waits for the page on
 * demand, as before. Pages already queued or rendered are left alone.
 */
export async function prepare(
  c: PoolClient,
  file: { id: string; version: number; sha256: string; path: string },
  options: { from?: number; count?: number; total?: number | null } = {},
): Promise<number> {
  if (!PREPARED_FORMATS.test(file.path)) return 0;
  const from = options.from ?? 1;
  const last = Math.min(from + (options.count ?? PREVIEW_WINDOW) - 1, options.total ?? PREPARE_PAGES, PREPARE_PAGES);
  if (last < from) return 0;
  await c.query("SAVEPOINT cloud_preview_prepare");
  try {
    // Share admission with foreground requests. Background preparation is optional:
    // skip it instead of delaying an upload behind another admission transaction.
    const admission = await c.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(732019, 32) AS acquired");
    if (!admission.rows[0]?.acquired) {
      await c.query("RELEASE SAVEPOINT cloud_preview_prepare");
      return 0;
    }
    if (!(await previewWorkerOnline(c))) {
      await c.query("RELEASE SAVEPOINT cloud_preview_prepare");
      return 0;
    }
    const counts = (await c.query<{ total: number; active: number }>("SELECT count(*)::int AS total,count(*) FILTER(WHERE status IN ('queued','running'))::int AS active FROM cloud_work_file_previews")).rows[0]!;
    const pages = Array.from({ length: last - from + 1 }, (_, index) => from + index);
    if (counts.total + pages.length > MAX_ROWS || counts.active + pages.length > MAX_BACKGROUND_ACTIVE) {
      await c.query("RELEASE SAVEPOINT cloud_preview_prepare");
      return 0;
    }
    let queued = 0;
    for (const page of pages) {
      const result = await c.query(
        "INSERT INTO cloud_work_file_previews(id,file_id,file_version,sha256,page,status,priority) VALUES($1,$2,$3,$4,$5,'queued',1) ON CONFLICT (file_id,sha256,page) DO NOTHING",
        [randomUUID(), file.id, file.version, file.sha256, page],
      );
      queued += result.rowCount ?? 0;
    }
    await c.query("RELEASE SAVEPOINT cloud_preview_prepare");
    return queued;
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT cloud_preview_prepare");
    return 0;
  }
}
