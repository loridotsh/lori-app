import { PROJECT_ACTIONS, type ProjectAction, type ProjectRole, type ProjectPolicy, type ProjectAccess } from "@lori-enterprise/contracts";

export const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  memoryEnabled: true, forceAskMe: true, exportsAllowed: true,
  externalWritesAllowed: false, managersManageMembers: false,
  managersManageConnections: false, providerModels: [], pluginIds: [],
  providerMode: "inherit", pluginMode: "inherit", skillMode: "inherit", skillIds: [],
};
const ROLE_ACTIONS: Record<ProjectRole, readonly ProjectAction[]> = {
  viewer: ["read"],
  contributor: ["read", "chat", "files.write", "memory.write", "export", "tools.use"],
  manager: PROJECT_ACTIONS,
};
const rank: Record<ProjectRole, number> = { viewer: 0, contributor: 1, manager: 2 };

/**
 * Restrictions are intersected after grants are combined; no grant bypasses a
 * block. Organization administrators (Owner and Admin) hold full access to
 * every shared project without grants, and member-level blocks or grant
 * denials do not reduce it. The project's own safety controls and lifecycle
 * still apply to everyone; administrators can change those explicitly.
 */
export function resolveProjectAccess(input: {
  grants: { role: ProjectRole; deniedActions: readonly ProjectAction[] }[];
  blocked: boolean;
  policy: ProjectPolicy;
  status: "active" | "archived" | "deleted";
  accessRevision: number;
  audited?: boolean;
  administrator?: boolean;
  memberDeniedActions?: readonly ProjectAction[];
}): ProjectAccess {
  const result: ProjectAccess = { role: null, actions: [], audited: false, accessRevision: input.accessRevision, source: null };
  if (input.status === "deleted") return result;
  const denied = new Set<ProjectAction>();
  const allowed = new Set<ProjectAction>();
  if (input.administrator) {
    result.role = "manager";
    result.source = "organization_admin";
    PROJECT_ACTIONS.forEach(action => allowed.add(action));
  } else {
    if (input.blocked) return result;
    (input.memberDeniedActions ?? []).forEach(action => denied.add(action));
    for (const grant of input.grants) {
      if (!result.role || rank[grant.role] > rank[result.role]) result.role = grant.role;
      ROLE_ACTIONS[grant.role].forEach(action => allowed.add(action));
      grant.deniedActions.forEach(action => denied.add(action));
    }
    if (input.grants.length) result.source = "grant";
    if (input.audited && !allowed.has("read") && !denied.has("read")) {
      allowed.add("read"); result.audited = true; result.source = "audited";
    }
    // Delegation switches: they bound what a project manager may do.
    if (!input.policy.managersManageMembers) denied.add("members.manage");
    if (!input.policy.managersManageConnections) denied.add("connections.manage");
  }
  // Project safety controls apply to everyone, administrators included.
  if (!input.policy.exportsAllowed) denied.add("export");
  if (!input.policy.externalWritesAllowed) denied.add("tools.write");
  if (!input.policy.memoryEnabled) { denied.add("memory.write"); denied.add("memory.delete"); }
  if (input.status !== "active") PROJECT_ACTIONS.filter(a => a !== "read" && a !== "export").forEach(a => denied.add(a));
  result.actions = PROJECT_ACTIONS.filter(a => allowed.has(a) && !denied.has(a));
  // Read is the common content boundary; an action never independently opens it.
  if (!result.actions.includes("read")) result.actions = [];
  return result;
}
