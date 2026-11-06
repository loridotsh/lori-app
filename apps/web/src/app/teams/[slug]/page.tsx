import { redirect } from "next/navigation";
import { TeamMembersManager } from "@/app/teams/[slug]/team-members-manager";
import { ProjectAdministrationAssignments } from "@/components/work/projects/project-administration-assignments";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { PolicyPersonalSettings } from "@/components/policy/policy-personal-settings";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/section";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator } from "@/lib/authority";
import {
  getEligibleTeamMembers,
  getTeam,
  getTeamMembers,
  getTeamPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  const { status: teamStatus, team } = await getTeam(slug);
  if (!team) {
    redirect(apiFailureDestination(teamStatus));
  }
  const [membersResult, eligibleResult, policyResult] = await Promise.all([
    getTeamMembers(team.id),
    getEligibleTeamMembers(team.id),
    getTeamPolicy(team.id),
  ]);
  if (!membersResult.members || !eligibleResult.members || !policyResult.policy) {
    redirect(
      apiFailureDestination(
        membersResult.status,
        eligibleResult.status,
        policyResult.status,
      ),
    );
  }
  const teamAdmins = membersResult.members.teamAdminCount ?? 0;
  const basePath = `/teams/${encodeURIComponent(team.slug)}`;

  return (
    <AppShell breadcrumb={team.name} current="teams" viewer={viewer}>
      <div className="space-y-8">
        <PageHeader
          description={
            team.description ||
            "Manage membership and the additive access policy for this team."
          }
          eyebrow={`/${team.slug}`}
          title={team.name}
        />

        <Panel className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="space-y-1 px-4 py-3.5 sm:px-5">
            <p className="text-xs font-medium text-muted-foreground">
              Members
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {team.memberCount}
            </p>
          </div>
          <div className="space-y-1 px-4 py-3.5 sm:px-5">
            <p className="text-xs font-medium text-muted-foreground">
              Team admins
            </p>
            <p className="text-lg font-semibold tabular-nums">{teamAdmins}</p>
          </div>
          <div className="space-y-1 px-4 py-3.5 sm:px-5">
            <p className="text-xs font-medium text-muted-foreground">
              Policy state
            </p>
            <Badge className="font-mono" variant="outline">
              Revision {policyResult.policy.revision}
            </Badge>
          </div>
        </Panel>

        {isAdministrator(viewer) && <ProjectAdministrationAssignments teamId={team.id} />}
        <TeamMembersManager
          initialEligible={eligibleResult.members}
          initialMembers={membersResult.members}
          team={team}
          viewer={viewer}
        />

        <PolicyPageFrame
          basePath={basePath}
          header={
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-foreground">
                Team access
              </h2>
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Team grants combine with organization defaults and the member’s
                other teams. Global member overrides still win last.
              </p>
            </div>
          }
        >
          <PolicyPersonalSettings
            initialTeamPolicy={policyResult.policy}
            mode="team"
            teamId={team.id}
          />
        </PolicyPageFrame>
      </div>
    </AppShell>
  );
}
