import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { AppConfig } from "../config.js";

export interface MigrationFile {
  checksum: string;
  name: string;
  sql: string;
}

export function readMigrationFiles(
  directory = resolve(import.meta.dirname, "../../migrations"),
): MigrationFile[] {
  return readdirSync(directory)
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((name) => {
      const sql = readFileSync(resolve(directory, name), "utf8");
      return {
        checksum: createHash("sha256").update(sql).digest("hex"),
        name,
        sql,
      };
    });
}

export interface DatabaseHealth {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPool(config: AppConfig["database"]): Pool {
  return new Pool({
    application_name: "lori-enterprise-api",
    connectionTimeoutMillis: 5_000,
    database: config.name,
    host: config.host,
    idleTimeoutMillis: 30_000,
    max: 10,
    password: config.password,
    port: config.port,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    user: config.user,
  });
}

export class PostgresHealth implements DatabaseHealth {
  public constructor(private readonly pool: Pool) {}

  public async check(): Promise<boolean> {
    try {
      const expected = readMigrationFiles();
      if (expected.length === 0) return false;

      const result = await this.pool.query<{
        checksum: string;
        name: string;
      }>("SELECT name, checksum FROM schema_migrations ORDER BY name");
      const applied = new Map(
        result.rows.map((migration) => [migration.name, migration.checksum]),
      );

      return (
        applied.size === expected.length &&
        expected.every(
          (migration) => applied.get(migration.name) === migration.checksum,
        )
      );
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
