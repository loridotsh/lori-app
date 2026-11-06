import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import {
  WorkPolicyEditor,
  type WorkMode,
} from "@/components/work/work-policy-editor";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import {
  CloudWorkOffNotice,
  OpenCloudWorkButton,
} from "@/components/work/cloud-work-access";
import {
  getCloudAvailability,
  getTeam,
  getViewer,
  getWorkCatalog,
  getWorkPolicy,
  getMemberPolicy,
  getTeamMemberPolicy,
} from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, ChartNoAxesCombinedIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkLoadError } from "@/components/work/work-load-error";
import { DelegationEditor } from "@/components/policy/delegation-editor";
import { Alert } from "@/components/ui/alert";
import { delegationApproves } from "@lori-enterprise/contracts";

export const dynamic = "force-dynamic";
export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const teamId = typeof query.team === "string" ? query.team : undefined;
  const memberId = typeof query.member === "string" ? query.member : undefined;
  const section =
    query.section === "providers" ||
    query.section === "extensions" ||
    (query.section === "delegation" && !teamId && !memberId)
      ? query.section
      : "access";
  const { viewer, status } = await getViewer();
  if (!viewer) redirect(apiFailureDestination(status));
  if (section === "delegation" && isPersonalWorkspace(viewer)) redirect("/work");
  const callback = new URLSearchParams();
  if (teamId) callback.set("team", teamId);
  if (memberId) callback.set("member", memberId);
  callback.set("section", section);
  const signInHref = `/sign-in?callback=${encodeURIComponent(`/work?${callback}`)}`;
  const failed = (
    statuses: number[],
    backHref = "/work",
    backLabel = "Your Work access",
  ) => {
    if (statuses.includes(401)) redirect(signInHref);
    const failure =
      statuses.find((code) => code >= 500 || code <= 0) ??
      statuses.find((code) => code >= 400) ??
      503;
    return (
      <AppShell current="work" viewer={viewer}>
        <div className="space-y-6">
          <PageHeader
            title="Work"
            description="Access, providers, and tools for your organization."
          />
          <WorkLoadError
            status={failure}
            backHref={backHref}
            backLabel={backLabel}
          />
        </div>
      </AppShell>
    );
  };
  const administrator = isAdministrator(viewer);
  if (!teamId && memberId && !administrator) return failed([403]);
  let mode: WorkMode = administrator ? "organization" : "viewer";
  let endpoint =
    administrator ? "/v1/admin/work/policy" : "/v1/work/policy";
  let title = administrator ? "Work" : "Your Work access";
  const personalWorkspace = isPersonalWorkspace(viewer);
  let description = personalWorkspace
    ? "Connect your AI providers and choose the models and tools you use in Work."
    : administrator
      ? "Set member access, connect AI providers, and choose the tools available in Work."
      : "See the models, tools, and permissions your organization makes available to you.";
  let back: { href: string; label: string } | undefined;
  const params = new URLSearchParams();
  if (teamId) {
    const team = await getTeam(teamId);
    if (!team.team) return failed([team.status]);
    const id = encodeURIComponent(team.team.id);
    mode = memberId ? "team-member" : "team";
    endpoint = `/v1/teams/${id}/work/${memberId ? `members/${encodeURIComponent(memberId)}/` : ""}policy`;
    title = `${team.team.name} · Work access`;
    description =
      "Choose the access this team grants. Organization settings and other team grants still apply.";
    back = {
      href: `/teams/${encodeURIComponent(team.team.slug)}`,
      label: team.team.name,
    };
    params.set("team", team.team.id);
    if (memberId) {
      const result = await getTeamMemberPolicy(team.team.id, memberId);
      if (!result.policy) return failed([result.status], back.href, back.label);
      title = `${result.policy.member.name} · ${team.team.name} · Work`;
      description =
        "Adjust this team’s contribution for the member. Other sources of access remain independent.";
    }
  } else if (memberId) {
    const result = await getMemberPolicy(memberId);
    if (!result.policy) return failed([result.status], "/people", "People");
    mode = "member";
    endpoint = `/v1/admin/work/members/${encodeURIComponent(memberId)}/policy`;
    title = `${result.policy.member.name} · Work access`;
    description =
      "Choose exceptions to this member’s inherited access. Individual member decisions take precedence.";
    back = {
      href: `/people/${encodeURIComponent(memberId)}`,
      label: result.policy.member.name,
    };
  }
  if (memberId) params.set("member", memberId);
  const [result, catalog] = await Promise.all([
    getWorkPolicy(endpoint),
    getWorkCatalog(),
  ]);
  if (!result.data || !catalog.data)
    return failed(
      [result.status, catalog.status],
      back?.href ?? "/",
      back?.label ?? "Enterprise overview",
    );
  const member = "effective" in result.data ? result.data : undefined;
  const policy =
    "effective" in result.data ? result.data.effective : result.data;
  const cloud = await getCloudAvailability();
  // Team grants outside the organization's approved delegation do not take effect.
  const delegation =
    "effective" in result.data
      ? result.data.inherited.delegation
      : result.data.delegation;
  const teamGrants =
    "effective" in result.data ? result.data.effective : result.data;
  const unapproved = delegation
    ? [
        ...teamGrants.managedCatalog
          .filter((item) => item.enabled && !delegationApproves(delegation, item))
          .map((item) => `${item.type} ${item.id}`),
        ...teamGrants.providerModels.flatMap((row) =>
          row.modelIds
            .filter(
              (model) =>
                !delegation.providerModels.some(
                  (approved) =>
                    approved.providerId === row.providerId &&
                    approved.modelIds.includes(model),
                ),
            )
            .map((model) => `model ${row.providerId}/${model}`),
        ),
      ]
    : [];
  return (
    <AppShell current="work" viewer={viewer}>
      <div className="space-y-6">
        <CloudWorkOffNotice
          initial={cloud.enabled}
          redirected={query.cloud === "off"}
          admin={administrator}
        />
        {back ? (
          <Link
            className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={back.href}
          >
            <ArrowLeftIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Back to {back.label}</span>
          </Link>
        ) : null}
        <PageHeader
          title={title}
          className="[&_h1]:break-words"
          description={description}
          actions={
            <div className="flex flex-wrap gap-2">
              <OpenCloudWorkButton initial={cloud.enabled} />
              {viewer.usageAnalytics?.canView ? (
                <Button asChild variant="outline">
                  <Link href="/work/usage">
                    <ChartNoAxesCombinedIcon />
                    View usage
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />
        <nav
          aria-label="Work sections"
          className="flex gap-1 overflow-x-auto border-b border-border"
        >
          {([
            "access",
            "providers",
            "extensions",
            ...(mode === "organization" && !personalWorkspace ? (["delegation"] as const) : []),
          ] as const).map((id) => {
            const next = new URLSearchParams(params);
            next.set("section", id);
            return (
              <Link
                key={id}
                href={`/work?${next}`}
                aria-current={id === section ? "page" : undefined}
                className={cn(
                  "shrink-0 border-b-2 px-3 py-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  id === section
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {id === "access"
                  ? "Access"
                  : id === "providers"
                    ? "Providers & models"
                    : id === "extensions"
                      ? "Plugins & skills"
                      : "Team delegation"}
              </Link>
            );
          })}
        </nav>
        {delegation && (
          <Alert variant={unapproved.length ? "warning" : "default"}>
            {unapproved.length
              ? `Not approved for team administrators, so these team grants do not take effect: ${unapproved.slice(0, 6).join(", ")}${unapproved.length > 6 ? `, and ${unapproved.length - 6} more` : ""}. An organization admin can approve them in Work → Team delegation.`
              : "Team administrators can grant only what the organization approved in Work → Team delegation, plus the organization defaults."}
          </Alert>
        )}
        {section === "delegation" && mode === "organization" ? (
          <DelegationEditor catalog={catalog.data} product="work" />
        ) : (
          <WorkPolicyEditor
            key={`${endpoint}:${section}:${policy.revision}`}
            initialPolicy={policy}
            initialMember={member}
            mode={mode}
            endpoint={endpoint}
            catalog={catalog.data}
            section={section === "delegation" ? "access" : section}
            canManageConnections={administrator}
            personalWorkspace={personalWorkspace}
          />
        )}
      </div>
    </AppShell>
  );
}
