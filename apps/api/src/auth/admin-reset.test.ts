import { verifyPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  resetAdministratorPassword,
  validateAdministratorResetInput,
} from "./admin-reset.js";

function clientFixture(role = "admin") {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      if (sql.includes("SELECT users.id")) {
        return {
          rowCount: 1,
          rows: [{ id: "user-1", organization_id: "org-1", role }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

describe("administrator password reset", () => {
  it("recovers an administrator who also belongs to other workspaces", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      async query(sql: string, values: unknown[] = []) {
        statements.push({ sql, values });
        return sql.includes("SELECT users.id")
          ? {
              rowCount: 2,
              rows: [
                { id: "user-1", organization_id: "org-1", role: "member" },
                { id: "user-1", organization_id: "org-2", role: "admin" },
              ],
            }
          : { rowCount: 1, rows: [] };
      },
    } as unknown as PoolClient;

    await resetAdministratorPassword(client, "admin@example.com", "a-secure-password");

    const audited = statements
      .filter((statement) => statement.sql.includes("INSERT INTO audit_events"))
      .map((statement) => statement.values[2]);
    expect(audited).toEqual(["org-1", "org-2"]);
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("validates the confirmed normalized email and password bounds", () => {
    expect(
      validateAdministratorResetInput(
        " Admin@Example.com ",
        "admin@example.com",
        "a-secure-password",
      ),
    ).toBe("admin@example.com");
    expect(() =>
      validateAdministratorResetInput(
        "admin@example.com",
        "other@example.com",
        "a-secure-password",
      ),
    ).toThrow(/exactly match/);
    expect(() =>
      validateAdministratorResetInput(
        "admin@example.com",
        "admin@example.com",
        "short",
      ),
    ).toThrow(/between 12 and 128/);
  });

  it("hashes the password, revokes sessions, audits, and commits", async () => {
    const { client, statements } = clientFixture();

    await resetAdministratorPassword(client, "admin@example.com", "a-secure-password");

    expect(statements[0]?.sql).toBe("BEGIN");
    expect(statements.at(-1)?.sql).toBe("COMMIT");
    const credentialUpdate = statements.find((statement) =>
      statement.sql.includes("UPDATE account"),
    );
    expect(credentialUpdate).toBeDefined();
    expect(
      await verifyPassword({
        hash: String(credentialUpdate?.values[0]),
        password: "a-secure-password",
      }),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.sql.includes("DELETE FROM session")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.sql.includes("UPDATE device_sessions")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.sql.includes("INSERT INTO audit_events")),
    ).toBe(true);
  });

  it("rejects non-admin members and rolls back", async () => {
    const { client, statements } = clientFixture("member");

    await expect(
      resetAdministratorPassword(client, "member@example.com", "a-secure-password"),
    ).rejects.toThrow(/administrator/);

    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(
      statements.some((statement) => statement.sql.includes("UPDATE account")),
    ).toBe(false);
  });
});
