import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { PolicyPersonalSettings } from "@/components/policy/policy-personal-settings";
import {
  getOrganizationPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function OrganizationPage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  const personalWorkspace = isPersonalWorkspace(viewer);
  const [{ policy, status }] = await Promise.all([getOrganizationPolicy()]);
  if (!policy) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell current="organization" viewer={viewer}>
      <PolicyPageFrame
        basePath="/organization"
        header={
          <PageHeader
            description={
              personalWorkspace
                ? "Control what you can install and configure in Lori."
                : "Control what members can install and configure outside the organization catalog."
            }
            title={personalWorkspace ? "Access" : "Organization access"}
          />
        }
        personalWorkspace={personalWorkspace}
      >
        <PolicyPersonalSettings
          initialPolicy={policy}
          mode="organization"
          personalWorkspace={personalWorkspace}
        />
      </PolicyPageFrame>
    </AppShell>
  );
}
