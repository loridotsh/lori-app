import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool } from "../../db/database.js";
import { loadDatabaseConfig } from "../../config.js";
import { ProjectKeyring } from "./crypto.js";
import { recordAuditEvent } from "../../auth/audit.js";

/** Uses the migration-owner connection during a maintenance window. Retain old KEKs until completion. */
export async function rewrapProjectKeys(pool: Pool, keyring: ProjectKeyring) {
  let count = 0;
  for (;;) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const rows = (await c.query("SELECT id,organization_id,wrapped_key FROM cloud_work_projects WHERE wrapped_key->>'key'<>$1 ORDER BY id LIMIT 100 FOR UPDATE", [keyring.active])).rows;
      if (!rows.length) { await c.query("COMMIT"); break; }
      for (const row of rows) {
        const context = keyring.unwrap(row.organization_id, row.id, row.wrapped_key);
        try { await c.query("UPDATE cloud_work_projects SET wrapped_key=$2 WHERE id=$1", [row.id, JSON.stringify(keyring.wrap(context))]); }
        finally { context.key.fill(0); }
        await recordAuditEvent(c, { action: "work.project.key_rewrapped", organizationId: row.organization_id, subjectType: "project", subjectId: row.id, metadata: { keyVersion: keyring.active } });
        count++;
      }
      await c.query("COMMIT");
    } catch (failure) { await c.query("ROLLBACK"); throw failure; }
    finally { c.release(); }
  }
  // Verify all project keys before the operator retires a previous wrapping key.
  const rows = (await pool.query("SELECT id,organization_id,wrapped_key FROM cloud_work_projects")).rows;
  for (const row of rows) keyring.unwrap(row.organization_id, row.id, row.wrapped_key).key.fill(0);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const probe = (await c.query("SELECT wrapped_key FROM cloud_work_project_key_check WHERE singleton FOR UPDATE")).rows[0];
    if (probe) {
      const context = keyring.unwrap("lori-key-check", "00000000-0000-0000-0000-000000000000", probe.wrapped_key);
      try { await c.query("UPDATE cloud_work_project_key_check SET wrapped_key=$1 WHERE singleton", [JSON.stringify(keyring.wrap(context))]); }
      finally { context.key.fill(0); }
    }
    await c.query("COMMIT");
  } catch (failure) { await c.query("ROLLBACK"); throw failure; }
  finally { c.release(); }
  return count;
}
async function main() {
  if (!process.argv.includes("--rewrap") || !process.env.WORK_CLOUD_PROJECT_KEYS_FILE) throw new Error("Use --rewrap with WORK_CLOUD_PROJECT_KEYS_FILE and migration-owner database credentials");
  const ring = ProjectKeyring.fromFile(process.env.WORK_CLOUD_PROJECT_KEYS_FILE), pool = createPool(loadDatabaseConfig());
  try { console.log(`Rewrapped and verified ${await rewrapProjectKeys(pool, ring)} project keys.`); }
  finally { await pool.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => { console.error("Project key rotation failed. Retain every existing key and inspect database connectivity and keyring completeness before retrying."); process.exitCode = 1; });
