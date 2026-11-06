import { redirect } from "next/navigation";
import { TeamsManager } from "@/app/teams/teams-manager";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { getTeams, getViewer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer) && viewer.teamAdmin !== true) {
    redirect("/unauthorized");
  }
  if (isPersonalWorkspace(viewer)) {
    redirect("/");
  }
  const { status, teams } = await getTeams();
  if (!teams) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell current="teams" viewer={viewer}>
      <div className="space-y-8">
        <PageHeader
          description="Group members into additive policy scopes, delegate team ownership, and keep exceptions visible."
          eyebrow={viewer.organization.name}
          title="Teams"
        />
        <TeamsManager initialTeams={teams} viewer={viewer} />
      </div>
    </AppShell>
  );
}
