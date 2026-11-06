import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getProjectCapabilities, getViewer } from "@/lib/server-api";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator } from "@/lib/authority";
import { ProjectsBrowser } from "@/components/work/projects/projects-browser";
export const dynamic = "force-dynamic";
export default async function WorkProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) notFound();
  const { viewer, status } = await getViewer();
  if (!viewer) redirect(apiFailureDestination(status));
  const capabilities = (await getProjectCapabilities()).data;
  const management = isAdministrator(viewer) || capabilities?.canManageProjects === true || capabilities?.canCreate === true;
  return <AppShell current="projects" breadcrumb="Project details" viewer={viewer}><ProjectsBrowser key={projectId} admin={isAdministrator(viewer)} projectId={projectId} management={management} /></AppShell>;
}
