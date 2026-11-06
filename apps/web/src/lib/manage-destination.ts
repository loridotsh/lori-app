import type { CloudProject, ProjectCapabilities, Viewer } from "@lori-enterprise/contracts";
import { isAdministrator } from "./authority";

/** Use effective actions, which already include policy, blocks and denied grants. */
export function canManageProject(project: CloudProject, organizationAdmin: boolean) {
  if (project.status === "deleted") return false;
  // Organization administrators manage every shared project.
  if (organizationAdmin) return true;
  return project.status === "active" && project.access.actions.includes("read") &&
    project.access.actions.some(action =>
      action === "instructions.write" || action === "members.manage" || action === "connections.manage");
}

export function manageDestination({ viewer, admin, project, projectCapabilities }: {
  viewer?: Viewer;
  admin: boolean;
  project?: CloudProject;
  projectCapabilities?: ProjectCapabilities | null;
}): { href: string; label: string } | null {
  const organizationAdmin = viewer ? isAdministrator(viewer) : admin;
  // Settings is the administrator's organization-wide entry point, even while
  // working inside a project. Project context must not narrow that destination.
  if (organizationAdmin) {
    return {
      href: "/",
      label: viewer?.organization.kind === "personal" ? "Manage account" : "Manage organization",
    };
  }
  if (project) {
    return canManageProject(project, false)
      ? { href: `/work/projects/${encodeURIComponent(project.id)}`, label: "Manage project" }
      : null;
  }
  if (viewer?.teamAdmin === true) return { href: "/teams", label: "Manage teams" };
  if (projectCapabilities?.available &&
      (projectCapabilities.canManageProjects === true || projectCapabilities.canCreate)) {
    return { href: "/work/projects", label: "Manage projects" };
  }
  return { href: "/", label: "Manage account" };
}
