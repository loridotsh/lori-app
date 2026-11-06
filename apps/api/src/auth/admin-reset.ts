import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { hashPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";
import { loadDatabaseConfig } from "../config.js";
import { createPool } from "../db/database.js";
import { normalizeEmail } from "./onboarding.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function readPasswordFromStdin(): Promise<string> {
  if (!process.argv.includes("--new-password-stdin")) {
    throw new Error("--new-password-stdin is required so the password is not exposed in process arguments.");
  }
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 130) throw new Error("The supplied password is too long.");
  }
  return value.replace(/\r?\n$/, "");
}

export function validateAdministratorResetInput(
  rawEmail: string,
  rawConfirmedEmail: string,
  password: string,
): string {
  const email = normalizeEmail(rawEmail);
  const confirmedEmail = normalizeEmail(rawConfirmedEmail);
  if (email !== confirmedEmail) throw new Error("--confirm-email must exactly match --email.");
  if (password.length < 12 || password.length > 128) {
    throw new Error("--new-password must contain between 12 and 128 characters.");
  }
  return email;
}

export async function resetAdministratorPassword(
  client: PoolClient,
  email: string,
  password: string,
): Promise<void> {
  try {
    await client.query("BEGIN");
    const userResult = await client.query<{
      id: string;
      organization_id: string;
      role: string;
    }>(
      `
        SELECT users.id, members."organizationId" AS organization_id, members.role
        FROM "user" users
        JOIN member members ON members."userId" = users.id
        WHERE LOWER(users.email) = $1
        FOR UPDATE OF users, members
      `,
      [email],
    );
    // Someone can administer one organization and be a member of another, and
    // their personal workspace makes them its Owner: any such role qualifies.
    const administered = userResult.rows.filter(
      (row) => row.role === "admin" || row.role === "owner",
    );
    const user = administered[0];
    if (!user) {
      throw new Error("The target must be an existing Enterprise administrator.");
    }

    const passwordHash = await hashPassword(password);
    const updated = await client.query(
      `
        UPDATE account
        SET password = $1, "updatedAt" = NOW()
        WHERE "userId" = $2 AND "providerId" = 'credential'
      `,
      [passwordHash, user.id],
    );
    if (updated.rowCount !== 1) throw new Error("The administrator credential was not found.");

    await client.query(`DELETE FROM session WHERE "userId" = $1`, [user.id]);
    await client.query(
      `
        UPDATE device_sessions sessions
        SET revoked_at = NOW(), revoked_reason = 'administrator_password_reset'
        FROM devices
        WHERE sessions.device_id = devices.id
          AND devices.user_id = $1
          AND sessions.revoked_at IS NULL
      `,
      [user.id],
    );
    for (const { organization_id: organizationId } of userResult.rows) {
      await client.query(
        `
          INSERT INTO audit_events (
            id,
            action,
            actor_user_id,
            organization_id,
            subject_type,
            subject_id,
            metadata
          ) VALUES ($1, $2, NULL, $3, $4, $5, $6)
        `,
        [
          randomUUID(),
          "administrator.password_reset_by_operator",
          organizationId,
          "user",
          user.id,
          JSON.stringify({ operator: "server_shell" }),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const password = await readPasswordFromStdin();
  const email = validateAdministratorResetInput(
    requiredOption("email"),
    requiredOption("confirm-email"),
    password,
  );
  const database = loadDatabaseConfig();
  const pool = createPool(database);
  const client = await pool.connect();
  try {
    await resetAdministratorPassword(client, email, password);
    process.stdout.write(
      `${JSON.stringify({ email, sessionsRevoked: true, status: "password_reset" })}\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Password reset failed."}\n`);
    process.exitCode = 1;
  });
}
