import type { PolicyCatalogItemType } from "@lori-enterprise/contracts";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyCatalogManager } from "@/components/policy/policy-catalog-manager";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { catalogTypeLabel } from "@/components/policy/policy-utils";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import {
  getPolicyCatalog,
  getTeam,
  getTeamPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

const validTypes: PolicyCatalogItemType[] = [
  "app",
  "plugin",
  "skill",
  "provider",
];

export default async function TeamCatalogPage({
  params,
}: {
  params: Promise<{ slug: string; type: string }>;
}) {
  const { slug, type } = await params;
  if (!validTypes.includes(type as PolicyCatalogItemType)) {
    redirect(`/teams/${encodeURIComponent(slug)}/catalog/app`);
  }
  const catalogType = type as PolicyCatalogItemType;
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  const { status: teamStatus, team } = await getTeam(slug);
  if (!team) {
    redirect(apiFailureDestination(teamStatus));
  }
  const [{ policy, status }, { catalog, status: catalogStatus }] =
    await Promise.all([getTeamPolicy(team.id), getPolicyCatalog()]);
  if (!policy || !catalog) {
    redirect(apiFailureDestination(status, catalogStatus));
  }

  return (
    <AppShell breadcrumb={team.name} current="teams" viewer={viewer}>
      <PolicyPageFrame
        basePath={`/teams/${encodeURIComponent(team.slug)}`}
        header={
          <PageHeader
            description={`Assign ${catalogTypeLabel(catalogType).toLowerCase()} to members of ${team.name}. Team assignments combine with other access grants.`}
            eyebrow={`/${team.slug}`}
            title={`${team.name} ${catalogTypeLabel(catalogType).toLowerCase()}`}
          />
        }
      >
        <PolicyCatalogManager
          catalog={catalog}
          catalogType={catalogType}
          initialTeamPolicy={policy}
          mode="team"
          teamId={team.id}
        />
      </PolicyPageFrame>
    </AppShell>
  );
}
