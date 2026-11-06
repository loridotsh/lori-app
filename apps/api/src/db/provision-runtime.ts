import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { loadDatabaseConfig } from "../config.js";
import { createPool } from "./database.js";

/** Run as the migration owner. The API never receives this owner's credential. */
export async function provisionRuntime(pool: Pool, role: string, password: string) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role) || password.length < 32 || password.length > 256 || /[\r\n\0]/.test(password)) throw new Error("Invalid runtime role configuration");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('lori-runtime-provision'))");
    const existing = (await c.query<{ unsafe: boolean }>("SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND pg_has_role(r.oid,t.relowner,'MEMBER')) AS unsafe FROM pg_roles r WHERE rolname=$1", [role])).rows[0];
    if (existing?.unsafe) throw new Error("The API runtime role must not own application tables or hold administrative privileges");
    // PostgreSQL formats identifiers and literals. Never print the resulting credential statement.
    const command = (await c.query<{ sql: string }>("SELECT format($1::text,$2::text,$3::text) AS sql", [`${existing ? "ALTER" : "CREATE"} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`, role, password])).rows[0]!.sql;
    await c.query(command);
    const grants = (await c.query<{ sql: string }>("SELECT format('GRANT CONNECT ON DATABASE %I TO %I; GRANT USAGE ON SCHEMA %I TO %I; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA %I TO %I; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I',current_database(),$1::text,current_schema(),$1::text,current_schema(),$1::text,current_schema(),$1::text,current_schema(),$1::text) AS sql", [role])).rows[0]!.sql;
    await c.query(grants);
    await c.query("COMMIT");
  } catch (failure) { await c.query("ROLLBACK"); throw failure; }
  finally { c.release(); }
}
async function main() {
  const file = process.env.DATABASE_RUNTIME_PASSWORD_FILE;
  if (!file) throw new Error("DATABASE_RUNTIME_PASSWORD_FILE is required");
  const pool = createPool(loadDatabaseConfig());
  try { await provisionRuntime(pool, process.env.DATABASE_RUNTIME_USER ?? "lori_runtime", readFileSync(file, "utf8").trim()); console.log("Provisioned the restricted API database role."); }
  finally { await pool.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => { console.error("Runtime database provisioning failed. Verify the migration-owner credentials and dedicated runtime role configuration."); process.exitCode = 1; });
