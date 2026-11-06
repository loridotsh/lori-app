import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { PolicyPersonalSettings } from "@/components/policy/policy-personal-settings";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { EffectivePolicySummary } from "@/components/policy/effective-policy-summary";
import { Button } from "@/components/ui/button";
import {
  getTeam,
  getTeamMemberPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function TeamMemberPolicyPage({
  params,
}: {
  params: Promise<{ memberId: string; slug: string }>;
}) {
  const { memberId, slug } = await params;
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  const { status: teamStatus, team } = await getTeam(slug);
  if (!team) {
    redirect(apiFailureDestination(teamStatus));
  }
  const { policy, status } = await getTeamMemberPolicy(team.id, memberId);
  if (!policy) {
    redirect(apiFailureDestination(status));
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
            description={`Control how ${team.name} contributes access for this member. Organization grants, other teams, and global member overrides remain independent.`}
            eyebrow={`${policy.member.email} · ${team.name}`}
            title={`${policy.member.name} overrides`}
          />
        }
      >
        <div className="space-y-8">
          <EffectivePolicySummary policy={policy.finalEffective} />
          <PolicyPersonalSettings
            initialTeamMemberPolicy={policy}
            mode="team-member"
            teamId={team.id}
          />
        </div>
      </PolicyPageFrame>
    </AppShell>
  );
}
