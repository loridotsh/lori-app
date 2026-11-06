/**
 * One organization authority model shared by API enforcement and web
 * presentation. The API remains authoritative: it computes the viewer's
 * snapshot with these helpers, and the web only renders what it was given.
 */
export const ORGANIZATION_ROLES = ["owner", "admin", "member"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Roles an invitation, promotion or demotion may assign. Ownership only moves by transfer. */
export const ASSIGNABLE_ORGANIZATION_ROLES = ["admin", "member"] as const;
export type AssignableOrganizationRole =
  (typeof ASSIGNABLE_ORGANIZATION_ROLES)[number];

export const ORGANIZATION_CAPABILITIES = [
  "ownership.transfer",
  "admins.manage",
  "members.manage",
  "teams.manage",
  "policies.manage",
  "providers.manage",
  "plugins.manage",
  "devices.manage",
  "usage.manage",
  "audit.read",
  "projects.administer",
] as const;
export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number];

const OWNER_ONLY = new Set<OrganizationCapability>([
  "ownership.transfer",
  "admins.manage",
]);

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return ORGANIZATION_ROLES.some((role) => role === value);
}

export function isAssignableOrganizationRole(
  value: unknown,
): value is AssignableOrganizationRole {
  return ASSIGNABLE_ORGANIZATION_ROLES.some((role) => role === value);
}

/** Owner and Admin share full operational authority; only the Owner appoints administrators. */
export function isOrganizationAdministrator(
  role: OrganizationRole | null | undefined,
): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

export function organizationCapabilities(
  role: OrganizationRole | null | undefined,
): OrganizationCapability[] {
  if (!isOrganizationAdministrator(role)) return [];
  return ORGANIZATION_CAPABILITIES.filter(
    (capability) => role === "owner" || !OWNER_ONLY.has(capability),
  );
}

export function hasOrganizationCapability(
  role: OrganizationRole | null | undefined,
  capability: OrganizationCapability,
): boolean {
  return organizationCapabilities(role).includes(capability);
}

/**
 * Older desktop clients accept only "admin" | "member". The Owner keeps full
 * administrator authority there; updated clients read `organizationRole`.
 */
export function legacyOrganizationRole(
  role: OrganizationRole,
): AssignableOrganizationRole {
  return role === "member" ? "member" : "admin";
}

export const ORGANIZATION_ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export const ORGANIZATION_ROLE_SUMMARIES: Record<OrganizationRole, string> = {
  owner:
    "Everything an admin can do, plus appointing or removing admins and transferring ownership.",
  admin:
    "Manages members, teams, policies, providers, models, plugins, skills, devices, usage, audit, and every shared project.",
  member:
    "Uses the organization, team, and project resources assigned to them.",
};

/** Why a change to another member's organization role is refused, or null when allowed. */
export type MembershipChangeDenial =
  | "admin_required"
  | "owner_required"
  | "owner_protected"
  | "self_change"
  | "invalid_role";

export function membershipChangeDenial(input: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  nextRole: AssignableOrganizationRole | "remove";
  self: boolean;
}): MembershipChangeDenial | null {
  if (!isOrganizationAdministrator(input.actorRole)) return "admin_required";
  if (input.self) return "self_change";
  if (input.targetRole === "owner") return "owner_protected";
  const touchesAdministrator =
    input.targetRole === "admin" || input.nextRole === "admin";
  if (touchesAdministrator && input.actorRole !== "owner")
    return "owner_required";
  if (
    input.nextRole !== "remove" &&
    !isAssignableOrganizationRole(input.nextRole)
  )
    return "invalid_role";
  return null;
}

/** The authority snapshot a signed-in viewer receives from the server. */
export interface OrganizationAuthority {
  role: OrganizationRole;
  capabilities: OrganizationCapability[];
  /** Organization access revision; it changes whenever roles or policies do. */
  revision: number;
  /** False when the organization has no Owner and an operator must assign one. */
  ownerAssigned: boolean;
}
