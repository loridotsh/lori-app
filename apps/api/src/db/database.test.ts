import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresHealth, readMigrationFiles } from "./database.js";

function healthWithRows(rows: Array<{ checksum: string; name: string }>) {
  const pool = {
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows })),
  } as unknown as Pool;
  return { health: new PostgresHealth(pool), pool };
}

describe("PostgresHealth", () => {
  it("requires every current migration with its expected checksum", async () => {
    const rows = readMigrationFiles().map(({ checksum, name }) => ({
      checksum,
      name,
    }));
    const { health } = healthWithRows(rows);

    await expect(health.check()).resolves.toBe(true);
  });

  it("rejects an incomplete or changed schema manifest", async () => {
    const [first, ...rest] = readMigrationFiles();
    const { health: incomplete } = healthWithRows(
      rest.map(({ checksum, name }) => ({ checksum, name })),
    );
    const { health: changed } = healthWithRows([
      { checksum: "wrong-checksum", name: first!.name },
      ...rest.map(({ checksum, name }) => ({ checksum, name })),
    ]);

    await expect(incomplete.check()).resolves.toBe(false);
    await expect(changed.check()).resolves.toBe(false);
  });

  it("fails closed when the schema manifest cannot be queried", async () => {
    const pool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as Pool;

    await expect(new PostgresHealth(pool).check()).resolves.toBe(false);
  });
});
