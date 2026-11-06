import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { getPeople, getSetupStatus, getViewer } from "@/lib/server-api";
import { PeopleManager } from "./people-manager";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  if (isPersonalWorkspace(viewer)) {
    redirect("/");
  }
  const [{ people, status }, setup] = await Promise.all([
    getPeople(),
    getSetupStatus(),
  ]);
  if (!people) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell current="people" viewer={viewer}>
      <div className="space-y-8">
        <PageHeader
          description="Manage members, roles, and invitations for your organization."
          title="People"
        />
        <PeopleManager
          initialPeople={people}
          publicSignup={setup?.publicSignup === true}
          viewer={viewer}
        />
      </div>
    </AppShell>
  );
}
