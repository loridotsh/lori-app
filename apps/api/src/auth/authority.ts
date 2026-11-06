import {
  isOrganizationAdministrator,
  isOrganizationRole,
  membershipChangeDenial,
  type AssignableOrganizationRole,
  type OrganizationRole,
} from "@lori-enterprise/contracts";
import { IdentityError } from "./errors.js";

export {
  isOrganizationAdministrator,
  legacyOrganizationRole,
  organizationCapabilities,
} from "@lori-enterprise/contracts";

/**
 * The one rule for which organization a browser session acts in. The session's
 * choice wins while the person still belongs to it; otherwise an enterprise
 * before a personal workspace, oldest membership first. A choice that names an
 * organization the person left can never match, so it grants nothing.
 */
export function activeOrganizationSql(user: string, preferred: string): string {
  return `(
    SELECT active_members."organizationId"
    FROM member active_members
    JOIN organization active_organizations
      ON active_organizations.id = active_members."organizationId"
    WHERE active_members."userId" = ${user}
    ORDER BY
      active_members."organizationId" IS NOT DISTINCT FROM ${preferred}::text DESC,
      active_organizations.personal_user_id IS NULL DESC,
      active_members."createdAt" ASC,
      active_members.id ASC
    LIMIT 1
  )`;
}

/** SQL list of roles with organization administrator authority. */
export const ADMINISTRATOR_ROLES_SQL = "('owner','admin')";

/** Stored roles are validated on every read; an unknown value fails closed. */
export function parseOrganizationRole(
  value: string | null | undefined,
): OrganizationRole {
  if (isOrganizationRole(value)) return value;
  throw new IdentityError(
    403,
    "membership_required",
    "Organization access is required.",
  );
}

export function administratorRequired(): IdentityError {
  return new IdentityError(
    403,
    "admin_required",
    "Administrator access is required.",
  );
}

export function ownerRequired(): IdentityError {
  return new IdentityError(
    403,
    "owner_required",
    "Only the organization owner can appoint, change, or remove administrators.",
  );
}

export function assertAdministrator(role: OrganizationRole): void {
  if (!isOrganizationAdministrator(role)) throw administratorRequired();
}

export function assertOwner(role: OrganizationRole): void {
  if (role !== "owner") throw ownerRequired();
}

/** Inviting an administrator is an appointment, so only the Owner may do it. */
export function assertInvitationAllowed(
  actorRole: OrganizationRole,
  role: AssignableOrganizationRole,
): void {
  assertAdministrator(actorRole);
  if (role === "admin") assertOwner(actorRole);
}

export function assertMembershipChange(input: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  nextRole: AssignableOrganizationRole | "remove";
  self: boolean;
}): void {
  switch (membershipChangeDenial(input)) {
    case null:
      return;
    case "admin_required":
      throw administratorRequired();
    case "owner_required":
      throw ownerRequired();
    case "self_change":
      throw new IdentityError(
        409,
        "self_role_change",
        input.actorRole === "owner"
          ? "Transfer ownership before changing your own role."
          : "Ask the organization owner to change your role.",
      );
    case "owner_protected":
      throw new IdentityError(
        409,
        "owner_protected",
        "The owner's role changes only by transferring ownership.",
      );
    case "invalid_role":
      throw new IdentityError(400, "invalid_role", "Choose admin or member.");
  }
}
