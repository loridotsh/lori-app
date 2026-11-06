import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { OpenLoriControl } from "@/components/open-lori-control";
import { policyStatusLabel } from "@/components/policy/policy-utils";
import { Alert } from "@/components/ui/alert";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { Panel, Section } from "@/components/ui/section";
import { AuthFrame } from "@/components/auth-frame";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import {
  getDevices,
  getPeople,
  getPolicy,
  getSetupStatus,
  getTeams,
  getViewer,
  getUsageAnalytics,
} from "@/lib/server-api";
import { formatEstimatedCost, formatCoveredCost, formatTokens } from "@/lib/usage-format";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const setup = await getSetupStatus();
  if (!setup) {
    return (
      <AuthFrame
        description="We couldn't reach Lori Enterprise right now."
        title="Service unavailable"
      >
        <Alert variant="destructive">
          Please try again in a moment. If the problem continues, contact your
          organization administrator.
        </Alert>
      </AuthFrame>
    );
  }
  if (setup.state === "requires_setup") {
    redirect("/setup");
  }

  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }

  const admin = isAdministrator(viewer);
  const personal = isPersonalWorkspace(viewer);
  const organizationAdmin = admin && !personal;
  const canManageTeams = !personal && (admin || viewer.teamAdmin === true);
  const usageTo = new Date();
  const usageFrom = new Date(usageTo);
  usageFrom.setUTCDate(usageFrom.getUTCDate() - 29);
  const [devicesResult, peopleResult, policyResult, teamsResult, usageResult, workUsageResult] =
    await Promise.all([
    getDevices(admin),
    organizationAdmin ? getPeople() : Promise.resolve({ people: null, status: 403 }),
    getPolicy(),
    canManageTeams
      ? getTeams()
      : Promise.resolve({ teams: null, status: 403 }),
    viewer.usageAnalytics?.canView
      ? getUsageAnalytics(admin, usageFrom.toISOString().slice(0, 10), usageTo.toISOString().slice(0, 10))
      : Promise.resolve({ analytics: null, status: 403 }),
    viewer.usageAnalytics?.canView
      ? getUsageAnalytics(admin, usageFrom.toISOString().slice(0, 10), usageTo.toISOString().slice(0, 10), "work")
      : Promise.resolve({ analytics: null, status: 403 }),
  ]);
  const connectedDevices =
    devicesResult.devices?.devices.filter(
      (device) => device.status === "connected",
    ).length ?? 0;
  const memberCount = peopleResult.people?.members.length;
  const teamCount = teamsResult.teams?.teams.length;
  const policy = policyResult.policy;
  const firstName = viewer.user.name.split(" ")[0];

  return (
    <AppShell current="overview" viewer={viewer}>
      <div className="space-y-8">
        <PageHeader
          description={
            personal
              ? "Your models, connected devices, and usage in one place."
              : admin
                ? "Manage your team, connected devices, and organization access from one place."
                : "View your connected devices and organization access settings."
          }
          eyebrow={viewer.organization.name}
          title={`Welcome back, ${firstName}`}
        />

        <MetricGrid
          className={
            organizationAdmin
              ? "sm:grid-cols-4"
              : canManageTeams
                ? "sm:grid-cols-3"
                : "sm:grid-cols-2"
          }
        >
          {organizationAdmin && (
            <Metric
              action="Manage people"
              href="/people"
              label="Members"
              value={memberCount ?? "—"}
            />
          )}
          {canManageTeams && (
            <Metric
              action="Manage teams"
              href="/teams"
              label="Teams"
              value={teamCount ?? "—"}
            />
          )}
          <Metric
            action="Review devices"
            href="/devices"
            label="Connected devices"
            value={connectedDevices}
          />
          <Metric
            action={admin ? "Manage access" : undefined}
            href={admin ? "/organization" : undefined}
            label="Personal installs"
            value={policyStatusLabel(policy?.personalInstallations ?? null)}
          />
        </MetricGrid>

        {viewer.usageAnalytics?.canView ? (
          <Section
            action={
              <Link className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline sm:min-h-0 sm:text-xs" href="/usage">
                Open usage analytics <ArrowRightIcon className="size-3.5" />
              </Link>
            }
            description={organizationAdmin ? "Organization usage received from enrolled Lori desktops." : "Your usage received from enrolled Lori desktops."}
            title="Code · Last 30 days"
          >
            <Panel className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="p-4 sm:p-5"><p className="text-xs font-medium text-muted-foreground">Tokens</p><p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{usageResult.analytics ? formatTokens(usageResult.analytics.totals.totalTokens) : "—"}</p></div>
              <div className="p-4 sm:p-5"><p className="text-xs font-medium text-muted-foreground">Estimated cost</p><p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{usageResult.analytics ? formatEstimatedCost(usageResult.analytics.totals.estimatedCostMicrousd) : "—"}</p></div>
            </Panel>
          </Section>
        ) : null}

        {viewer.usageAnalytics?.canView ? (
          <Section title="Work · Last 30 days"
            description={organizationAdmin ? "Organization Work usage from desktop and Cloud." : "Your Work usage from desktop and Cloud."}
            action={<Link className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline sm:min-h-0 sm:text-xs" href="/work/usage">Open Work usage <ArrowRightIcon className="size-3.5" /></Link>}>
            <Panel className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="p-4 sm:p-5"><p className="text-xs font-medium text-muted-foreground">Work tokens</p><p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{workUsageResult.analytics ? formatTokens(workUsageResult.analytics.totals.totalTokens) : "—"}</p></div>
              <div className="p-4 sm:p-5"><p className="text-xs font-medium text-muted-foreground">Estimated Work cost</p><p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{workUsageResult.analytics ? formatCoveredCost(workUsageResult.analytics.totals) : "—"}</p></div>
            </Panel>
          </Section>
        ) : null}

        <Section
          description={`Open Lori with this ${personal ? "account" : "organization"} address already configured. Your signed-in browser completes the secure device approval.`}
          title="Lori desktop"
        >
          <Panel className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] sm:items-center sm:p-5">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">
                Connect this computer
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                No server address needs to be entered in Lori. Device approval
                remains explicit and uses a one-time PKCE request.
              </p>
            </div>
            <OpenLoriControl publicUrl={setup.publicUrl} />
          </Panel>
        </Section>

      </div>
    </AppShell>
  );
}
