import type { CloudProject, ProjectRole, ProjectStatus } from "./cloud-projects.js";

/** Manage-only contracts. Member chat and native project protocols are unchanged. */
export interface ProjectManagementFilters {
  projectId?: string;
  query?: string;
  status?: ProjectStatus;
  memberId?: string;
  teamId?: string;
}
export interface ProjectAssignmentSummary {
  teams: { id: string; name: string; role: ProjectRole }[];
  members: { id: string; name: string; role: ProjectRole; blocked: boolean }[];
  teamCount: number;
  directMemberCount: number;
  blockedMemberCount: number;
}
export interface ManagedProject extends CloudProject { assignments?: ProjectAssignmentSummary }
export interface ProjectManagementPage {
  projects: ManagedProject[];
  nextCursor: string | null;
  canCreate: boolean;
  canAdminister: boolean;
  /** Inventory totals exclude text search and are supplied only to org admins. */
  total?: number;
  activeCount?: number;
}
