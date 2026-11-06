import type { PolicyCatalogItemType } from "@lori-enterprise/contracts";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyCatalogManager } from "@/components/policy/policy-catalog-manager";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { catalogTypeLabel } from "@/components/policy/policy-utils";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator } from "@/lib/authority";
import {
  getOrganizationPolicy,
  getPolicyCatalog,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

const validTypes: PolicyCatalogItemType[] = [
  "app",
  "plugin",
  "skill",
  "provider",
];

export default async function OrganizationCatalogPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  if (!validTypes.includes(type as PolicyCatalogItemType)) {
    redirect("/organization/catalog/app");
  }
  const catalogType = type as PolicyCatalogItemType;

  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  const [{ policy, status }, { catalog, status: catalogStatus }] =
    await Promise.all([getOrganizationPolicy(), getPolicyCatalog()]);
  if (!policy || !catalog) {
    redirect(apiFailureDestination(status, catalogStatus));
  }

  return (
    <AppShell current="organization" viewer={viewer}>
      <PolicyPageFrame
        basePath="/organization"
        header={
          <PageHeader
            description={`Assign ${catalogTypeLabel(catalogType).toLowerCase()} that every member receives by default.`}
            title={`Organization ${catalogTypeLabel(catalogType).toLowerCase()}`}
          />
        }
      >
        <PolicyCatalogManager
          catalog={catalog}
          catalogType={catalogType}
          initialPolicy={policy}
          mode="organization"
        />
      </PolicyPageFrame>
    </AppShell>
  );
}
