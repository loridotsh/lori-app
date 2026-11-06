/** Projects are organization-owned Cloud resources, never local folders. */
export const CLOUD_PROJECT_PROTOCOL_VERSION = 1 as const;
export const PROJECT_ACTIONS = [
  "read", "chat", "files.write", "files.delete", "memory.write", "memory.delete",
  "instructions.write", "conversations.delete", "export", "tools.use", "tools.write",
  "runs.manage", "approvals.manage", "connections.manage", "members.manage",
] as const;
export type ProjectAction = typeof PROJECT_ACTIONS[number];
export type ProjectRole = "viewer" | "contributor" | "manager";
export type ProjectStatus = "active" | "archived" | "deleted";
/**
 * "inherit": the project uses each member's existing Work assignments.
 * "assigned": exactly the listed resources are usable inside this project,
 * without a separate general assignment. An empty assigned list means none.
 */
export type ProjectResourceMode = "inherit" | "assigned";
export interface ProjectPolicy {
  memoryEnabled: boolean;
  forceAskMe: boolean;
  exportsAllowed: boolean;
  externalWritesAllowed: boolean;
  managersManageMembers: boolean;
  managersManageConnections: boolean;
  providerModels: { providerId: string; modelIds: string[] }[];
  pluginIds: string[];
  /** Absent in policies written before resource modes: a nonempty list is an assignment. */
  providerMode?: ProjectResourceMode;
  pluginMode?: ProjectResourceMode;
  skillMode?: ProjectResourceMode;
  skillIds?: string[];
}
export interface ResolvedProjectPolicy extends ProjectPolicy {
  providerMode: ProjectResourceMode;
  pluginMode: ProjectResourceMode;
  skillMode: ProjectResourceMode;
  skillIds: string[];
}
/** Fills resource modes for stored policies; the same rule runs in the API and the web. */
export function resolveProjectPolicy(policy: ProjectPolicy): ResolvedProjectPolicy {
  const skillIds = policy.skillIds ?? [];
  return {
    ...policy,
    skillIds,
    providerMode: policy.providerMode ?? (policy.providerModels.length ? "assigned" : "inherit"),
    pluginMode: policy.pluginMode ?? (policy.pluginIds.length ? "assigned" : "inherit"),
    skillMode: policy.skillMode ?? (skillIds.length ? "assigned" : "inherit"),
  };
}
/** Where a member's project access comes from. */
export type ProjectAccessSource = "organization_admin" | "grant" | "audited";
export interface ProjectAccess {
  memberId?: string;
  role: ProjectRole | null;
  actions: ProjectAction[];
  audited: boolean;
  accessRevision: number;
  source?: ProjectAccessSource | null;
}
/** Why a Work resource is unavailable to a member in a scope. */
export type WorkResourceDenialReason =
  | "work_disabled"
  | "not_assigned"
  | "not_assigned_to_project"
  | "not_approved"
  | "member_restricted"
  | "not_connected";
export interface ProjectResourceAvailability {
  id: string;
  name: string;
  allowed: boolean;
  reason?: WorkResourceDenialReason;
  source?: "member_policy" | "project_assignment" | "organization_admin";
}
/** A member's effective access in one project, from the same resolver the API enforces. */
export interface ProjectEffectiveAccess {
  access: ProjectAccess;
  workEnabled: boolean;
  blocked: boolean;
  administrator?: boolean;
  sources: ProjectGrant[];
  resources?: {
    providerMode: ProjectResourceMode;
    pluginMode: ProjectResourceMode;
    skillMode: ProjectResourceMode;
    models: (ProjectResourceAvailability & { providerId: string; providerName: string })[];
    plugins: ProjectResourceAvailability[];
    skills: ProjectResourceAvailability[];
  };
}
export interface CloudProject {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  revision: number;
  accessRevision: number;
  createdAt: string;
  updatedAt: string;
  purgeAfter: string | null;
  access: ProjectAccess;
}
export interface CloudProjectDetail extends CloudProject {
  instructions: string;
  policy: ProjectPolicy;
}
export interface ProjectGrant {
  id: string;
  kind: "member" | "team";
  subjectId: string;
  role: ProjectRole;
  deniedActions: ProjectAction[];
}
export interface ProjectMemberBlock { memberId: string }
export interface ProjectMemberships {
  grants: ProjectGrant[];
  blocks: ProjectMemberBlock[];
  revision: number;
}
export interface ProjectCapabilities {
  desktopAvailable?: boolean;
  version: 1;
  available: boolean;
  canCreate: boolean;
  canAdminister: boolean;
  canManageProjects?: boolean;
}
export interface ProjectMemory {
  id: string;
  topic: string;
  content: string;
  sensitive: boolean;
  revision: number;
  sourceMessageId: string | null;
  provenance: "manual" | "approved_tool";
  createdAt: string;
  updatedAt: string;
}
export interface ProjectSource {
  id: string;
  kind: "message" | "file" | "memory";
  title: string;
  excerpt: string;
  conversationId?: string;
  fileId?: string;
  version?: number;
}
