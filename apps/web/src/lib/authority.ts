import {
  hasOrganizationCapability,
  isOrganizationAdministrator,
  ORGANIZATION_ROLE_LABELS,
  type OrganizationCapability,
  type Role,
  type Viewer,
} from "@lori-enterprise/contracts";

/**
 * The web renders the server's authority decision; it never widens it.
 * Owner and Admin share organization administration.
 */
export function isAdministrator(viewer: Pick<Viewer, "role"> | null | undefined): boolean {
  return isOrganizationAdministrator(viewer?.role);
}

/** Prefers the server-computed capability snapshot, falling back to the shared role rules. */
export function canDo(viewer: Pick<Viewer, "role" | "authority">, capability: OrganizationCapability): boolean {
  return viewer.authority
    ? viewer.authority.capabilities.includes(capability)
    : hasOrganizationCapability(viewer.role, capability);
}

/** An individual's one-person workspace: nobody to invite, nothing to delegate. */
export function isPersonalWorkspace(viewer: Pick<Viewer, "organization"> | null | undefined): boolean {
  return viewer?.organization.kind === "personal";
}

export function roleLabel(role: Role | undefined): string {
  return role ? ORGANIZATION_ROLE_LABELS[role] : "Member";
}
