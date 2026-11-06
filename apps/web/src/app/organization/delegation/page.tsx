import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DelegationEditor } from "@/components/policy/delegation-editor";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { getPolicyCatalog, getViewer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function OrganizationDelegationPage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  if (isPersonalWorkspace(viewer)) {
    redirect("/organization");
  }
  const { catalog, status } = await getPolicyCatalog();
  if (!catalog) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell current="organization" viewer={viewer}>
      <PolicyPageFrame
        basePath="/organization"
        header={
          <PageHeader
            description="Choose what team administrators may grant to their teams in Lori Code."
            title="Organization access"
          />
        }
      >
        <DelegationEditor catalog={catalog} product="code" />
      </PolicyPageFrame>
    </AppShell>
  );
}
