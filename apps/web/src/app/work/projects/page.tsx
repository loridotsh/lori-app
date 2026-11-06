import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getProjectCapabilities, getViewer } from "@/lib/server-api";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator } from "@/lib/authority";
import { ProjectsBrowser } from "@/components/work/projects/projects-browser";
import { ManagedProjectsBrowser } from "@/components/work/projects/managed-projects-browser";
export const dynamic = "force-dynamic";
export default async function WorkProjectsPage({ searchParams }: { searchParams: Promise<{ memberId?: string; teamId?: string; tab?: string }> }) {
  const { viewer, status } = await getViewer();
  if (!viewer) redirect(apiFailureDestination(status));
  const capabilities = (await getProjectCapabilities()).data;
  const management = isAdministrator(viewer) || capabilities?.canManageProjects === true || capabilities?.canCreate === true;
  const filters = await searchParams;
  return <AppShell current="projects" viewer={viewer} wide><div className="space-y-6"><PageHeader title="Projects" description={isAdministrator(viewer) ? "Shared workspaces for your organization. Open a project to manage its settings and access." : "The shared workspaces you have access to. Open a project to see its details and available settings."} />{management ? <ManagedProjectsBrowser initialTab={filters.tab === "creation" ? "creation" : "projects"} initialFilters={{ memberId: typeof filters.memberId === "string" ? filters.memberId.slice(0, 128) : undefined, teamId: typeof filters.teamId === "string" ? filters.teamId.slice(0, 128) : undefined }} /> : <ProjectsBrowser admin={false} />}</div></AppShell>;
}
