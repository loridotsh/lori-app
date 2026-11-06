import type { PolicyCatalogItemType } from "@lori-enterprise/contracts";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyCatalogManager } from "@/components/policy/policy-catalog-manager";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { catalogTypeLabel } from "@/components/policy/policy-utils";
import { Button } from "@/components/ui/button";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import {
  getPolicyCatalog,
  getTeam,
  getTeamMemberPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

const validTypes: PolicyCatalogItemType[] = [
  "app",
  "plugin",
  "skill",
  "provider",
];

export default async function TeamMemberCatalogPage({
  params,
}: {
  params: Promise<{ memberId: string; slug: string; type: string }>;
}) {
  const { memberId, slug, type } = await params;
  if (!validTypes.includes(type as PolicyCatalogItemType)) {
    redirect(
      `/teams/${encodeURIComponent(slug)}/members/${encodeURIComponent(memberId)}/catalog/app`,
    );
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
    await Promise.all([
      getTeamMemberPolicy(team.id, memberId),
      getPolicyCatalog(),
    ]);
  if (!policy || !catalog) {
    redirect(apiFailureDestination(status, catalogStatus));
  }
  const teamPath = `/teams/${encodeURIComponent(team.slug)}`;
  const basePath = `${teamPath}/members/${encodeURIComponent(memberId)}`;

  return (
    <AppShell
      breadcrumb={`${team.name} · ${policy.member.name}`}
      current="teams"
      viewer={viewer}
    >
      <PolicyPageFrame
        basePath={basePath}
        header={
          <PageHeader
            actions={
              <Button asChild size="sm" variant="outline">
                <Link href={teamPath}>
                  <ArrowLeftIcon className="size-3.5" />
                  Back to team
                </Link>
              </Button>
            }
            description={`Adjust ${team.name}’s ${catalogTypeLabel(catalogType).toLowerCase()} contribution for ${policy.member.name}.`}
            eyebrow={`${policy.member.email} · ${team.name}`}
            title={`${policy.member.name} ${catalogTypeLabel(catalogType).toLowerCase()}`}
          />
        }
      >
        <PolicyCatalogManager
          catalog={catalog}
          catalogType={catalogType}
          initialTeamMemberPolicy={policy}
          mode="team-member"
          teamId={team.id}
        />
      </PolicyPageFrame>
    </AppShell>
  );
}
