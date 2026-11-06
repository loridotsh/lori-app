import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadDatabaseConfig } from "../apps/api/src/config.ts";
import { createPool } from "../apps/api/src/db/database.ts";
import { provisionRuntime } from "../apps/api/src/db/provision-runtime.ts";
import { ProjectKeyring } from "../apps/api/src/cloud/projects/crypto.ts";

/** Run only as a local dev preparation step, with the migration owner's credentials. */
export async function prepareDevelopmentProjects(env = process.env) {
  if (env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1"].includes(env.DATABASE_HOST ?? "127.0.0.1")) throw new Error("Local development database required.");
  const keys = ProjectKeyring.fromFile(env.WORK_CLOUD_PROJECT_KEYS_FILE);
  const password = readFileSync(env.DATABASE_RUNTIME_PASSWORD_FILE, "utf8").trim();
  const pool = createPool(loadDatabaseConfig(env));
  try {
    // Verify the established wrapping key before altering credentials or grants.
    // A missing/wrong key must never be replaced with a freshly generated one.
    const check = (await pool.query("SELECT wrapped_key FROM cloud_work_project_key_check WHERE singleton")).rows[0];
    if (check) keys.unwrap("lori-key-check", "00000000-0000-0000-0000-000000000000", check.wrapped_key).key.fill(0);
    await provisionRuntime(pool, env.DATABASE_RUNTIME_USER, password);
  } finally { await pool.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  prepareDevelopmentProjects().then(() => console.log("Project storage keys verified; restricted database role prepared for web and desktop Projects.")).catch(() => {
    console.error("Project storage preparation failed. Verify existing project keys, migration-owner credentials, and the restricted runtime role. No encryption keys or project data were replaced.");
    process.exitCode = 1;
  });
}
