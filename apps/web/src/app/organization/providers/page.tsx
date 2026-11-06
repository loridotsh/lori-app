import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicySubNav } from "@/components/policy/policy-sub-nav";
import { OrganizationProviderGatewayManager } from "@/app/organization/providers/provider-gateway-manager";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import {
  getOrganizationPolicy,
  getOrganizationProviderGatewayCatalog,
  getOrganizationProviderGateways,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function OrganizationProvidersPage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) redirect("/unauthorized");
  const personalWorkspace = isPersonalWorkspace(viewer);

  const [gatewaysResult, catalogResult, policyResult] = await Promise.all([
    getOrganizationProviderGateways(),
    getOrganizationProviderGatewayCatalog(),
    getOrganizationPolicy(),
  ]);
  if (!gatewaysResult.gateways || !catalogResult.catalog || !policyResult.policy) {
    redirect(
      apiFailureDestination(
        gatewaysResult.status,
        catalogResult.status,
        policyResult.status,
      ),
    );
  }

  return (
    <AppShell current="organization" viewer={viewer}>
      <div className="space-y-8">
        <PageHeader
          description={
            personalWorkspace
              ? "Connect your AI providers for Lori Code. Your keys are encrypted and never reach your Lori installation."
              : "Connect company-owned AI providers once, then assign them through organization or team access policies. Provider keys never reach a member’s Lori installation."
          }
          title={personalWorkspace ? "Providers" : "Organization providers"}
        />
        <PolicySubNav basePath="/organization" personalWorkspace={personalWorkspace} />
        <OrganizationProviderGatewayManager
          initialCatalog={catalogResult.catalog}
          initialGateways={gatewaysResult.gateways}
          initialRevision={policyResult.policy.revision}
        />
      </div>
    </AppShell>
  );
}
