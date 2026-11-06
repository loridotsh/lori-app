import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ProjectAdministrationAssignments } from "@/components/work/projects/project-administration-assignments";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { PolicyPersonalSettings } from "@/components/policy/policy-personal-settings";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, roleLabel } from "@/lib/authority";
import {
  getMemberPolicy,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function MemberPolicyPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  const [{ policy, status }] = await Promise.all([getMemberPolicy(memberId)]);
  if (!policy) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell
      breadcrumb={policy.member.name}
      current="people"
      viewer={viewer}
    >
      <div className="space-y-8"><ProjectAdministrationAssignments memberId={memberId} />
      <PolicyPageFrame
        basePath={`/people/${encodeURIComponent(memberId)}`}
        header={
          <>
            <Link
              className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              href="/people"
            >
              <ChevronLeftIcon className="size-4" />
              People
            </Link>
            <PageHeader
              description={`Control what ${policy.member.name} can install and configure outside the organization catalog.`}
              eyebrow={roleLabel(policy.member.role)}
              title={`Access for ${policy.member.name}`}
            />
          </>
        }
      >
        <PolicyPersonalSettings
          initialMemberPolicy={policy}
          mode="member"
        />
      </PolicyPageFrame></div>
    </AppShell>
  );
}
