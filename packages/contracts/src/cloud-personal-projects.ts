/**
 * Personal projects are owner-only folders over a member's private Cloud
 * conversations. They are not team workspaces: nothing here can be shared,
 * assigned, transferred or converted.
 */
export const PERSONAL_PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
export type PersonalProjectStatus = (typeof PERSONAL_PROJECT_STATUSES)[number];

/** Where a member's effective permission to create personal projects comes from. */
export type PersonalProjectCreationSource =
  | "organization_admin"
  | "everyone"
  | "member_grant"
  | "team_grant"
  | "blocked"
  | "none"
  | "unavailable";

export interface PersonalProjectCreationPermission {
  allowed: boolean;
  source: PersonalProjectCreationSource;
}

export interface PersonalProject {
  id: string;
  name: string;
  description: string;
  status: PersonalProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  /** When a deleted project and its chats are permanently removed. */
  purgeAfter: string | null;
  conversationCount: number;
  referenceCount: number;
}

export interface PersonalProjectDetail extends PersonalProject {
  instructions: string;
}

export interface PersonalProjectReference {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalProjectCapabilities {
  version: 1;
  /** Cloud Work is on for this member and the server can serve personal projects. */
  available: boolean;
  canCreate: boolean;
  source: PersonalProjectCreationSource;
  /** Retained projects, archived and recoverable-deleted included. */
  count: number;
  limit: number;
  /** Administrators only: whether they may change the creation policy. */
  canAdminister: boolean;
  recoveryDays: number;
}

export interface PersonalProjectCreationGrant {
  kind: "member" | "team";
  subjectId: string;
}

export interface PersonalProjectCreationPolicy {
  revision: number;
  /** "Allow all Work-enabled users to create personal projects." */
  allowAll: boolean;
  /** Grants apply only while allowAll is off. */
  grants: PersonalProjectCreationGrant[];
  /** Explicit blocks override every grant, including allowAll. */
  blockedMemberIds: string[];
  /** Per-member cap of retained projects; null follows the server default. */
  maxPerMember: number | null;
  defaultMaxPerMember: number;
}

export interface PersonalProjectEffectivePermission extends PersonalProjectCreationPermission {
  memberId: string;
}

export interface PersonalProjectContextReference {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
}
