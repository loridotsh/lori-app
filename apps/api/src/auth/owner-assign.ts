import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

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

export function validateOwnerAssignmentInput(
  rawEmail: string,
  rawConfirmedEmail: string,
): string {
  const email = normalizeEmail(rawEmail);
  if (email !== normalizeEmail(rawConfirmedEmail)) {
    throw new Error("--confirm-email must exactly match --email.");
  }
  return email;
}

/**
 * Operator recovery for an organization without an Owner, for example when
 * the setup administrator was removed before ownership existed. It never
 * replaces an existing Owner: that requires an in-app ownership transfer.
 */
export async function assignOrganizationOwner(
  client: PoolClient,
  email: string,
  /** Required when the person belongs to more than one organization. */
  organizationId?: string,
): Promise<{ organizationId: string; memberId: string }> {
  try {
    await client.query("BEGIN");
    const targetQuery = (lock: boolean) =>
      client.query<{
        member_id: string;
        organization_id: string;
        role: string;
        user_id: string;
      }>(
        `
          SELECT members.id AS member_id, members."organizationId" AS organization_id,
            members.role, users.id AS user_id
          FROM "user" users
          JOIN member members ON members."userId" = users.id
          WHERE LOWER(users.email) = $1
            AND ($2::text IS NULL OR members."organizationId" = $2)
          ${lock ? "FOR UPDATE OF members" : ""}
        `,
        [email, organizationId ?? null],
      );
    const found = (await targetQuery(false)).rows;
    if (found.length > 1) {
      throw new Error(
        "This person belongs to several organizations. Choose one with --organization.",
      );
    }
    if (!found[0]) {
      throw new Error("The target must be an existing Enterprise member.");
    }
    // Lock in the same order as the API (organization, then member) so this
    // tool cannot deadlock with a concurrent role change.
    await client.query(
      "SELECT 1 FROM organization_policies WHERE organization_id = $1 FOR UPDATE",
      [found[0].organization_id],
    );
    const target = await targetQuery(true);
    const row = target.rows[0];
    if (target.rows.length !== 1 || !row || row.organization_id !== found[0].organization_id) {
      throw new Error("The target must be an existing Enterprise member.");
    }
    const owner = await client.query(
      `SELECT 1 FROM member WHERE "organizationId" = $1 AND role = 'owner'`,
      [row.organization_id],
    );
    if (owner.rowCount) {
      throw new Error(
        "This organization already has an owner. Ownership can only move by an in-app transfer.",
      );
    }
    if (row.role !== "admin") {
      throw new Error(
        "Choose an existing administrator. Promote the person to admin first if needed.",
      );
    }
    await client.query("UPDATE member SET role = 'owner' WHERE id = $1", [
      row.member_id,
    ]);
    await client.query(
      `
        UPDATE organization_policies
        SET revision = revision + 1, updated_at = NOW()
        WHERE organization_id = $1
      `,
      [row.organization_id],
    );
    await client.query(
      `
        INSERT INTO audit_events (
          id, action, actor_user_id, organization_id, subject_type, subject_id, metadata
        ) VALUES ($1, 'organization.owner_assigned_by_operator', NULL, $2, 'user', $3, $4)
      `,
      [
        randomUUID(),
        row.organization_id,
        row.user_id,
        JSON.stringify({ operator: "server_shell", memberId: row.member_id }),
      ],
    );
    await client.query("COMMIT");
    return { memberId: row.member_id, organizationId: row.organization_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const email = validateOwnerAssignmentInput(
    requiredOption("email"),
    requiredOption("confirm-email"),
  );
  const pool = createPool(loadDatabaseConfig());
  const client = await pool.connect();
  try {
    await assignOrganizationOwner(client, email, option("organization")?.trim());
    process.stdout.write(`${JSON.stringify({ email, status: "owner_assigned" })}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Owner assignment failed."}\n`,
    );
    process.exitCode = 1;
  });
}
