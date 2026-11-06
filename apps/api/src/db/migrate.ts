import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool, PoolClient } from "pg";
import { loadDatabaseConfig } from "../config.js";
import { createPool, readMigrationFiles } from "./database.js";

interface AppliedMigration {
  checksum: string;
  name: string;
}

async function applyMigration(
  client: PoolClient,
  file: string,
  checksum: string,
  sql: string,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
      [file, checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrate(
  pool: Pool,
  directory?: string,
): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('lori-enterprise-migrations'))",
    );
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const result = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const applied = new Map(
      result.rows.map((migration) => [migration.name, migration.checksum]),
    );
    const files = readMigrationFiles(directory);
    const currentNames = new Set(files.map((file) => file.name));
    const unknownApplied = result.rows
      .map((migration) => migration.name)
      .filter((name) => !currentNames.has(name));

    if (unknownApplied.length > 0) {
      throw new Error(
        `Database contains migrations not present in this build: ${unknownApplied.join(", ")}`,
      );
    }

    for (const file of files) {
      const existingChecksum = applied.get(file.name);

      if (existingChecksum && existingChecksum !== file.checksum) {
        throw new Error(`Applied migration ${file.name} has changed`);
      }

      if (existingChecksum) {
        continue;
      }

      await applyMigration(client, file.name, file.checksum, file.sql);
    }
  } finally {
    if (lockAcquired) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('lori-enterprise-migrations'))",
      );
    }
    client.release();
  }
}

async function run(): Promise<void> {
  const database = loadDatabaseConfig();
  const pool = createPool(database);

  try {
    await migrate(pool);
    console.log(`Applied database migrations to ${database.name}`);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === entrypoint) {
  await run();
}
