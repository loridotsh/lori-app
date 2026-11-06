import type { AuditEventsResponse } from "@lori-enterprise/contracts";
import { ChevronDownIcon, DownloadIcon, ScrollTextIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel, Section } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";

const actions = [
  "team.created",
  "team.updated",
  "team.deleted",
  "team.member_added",
  "team.members_added",
  "team.member_removed",
  "usage.member_anonymized",
  "usage.member_deleted",
  "usage.member_deletion_requested",
  "usage.member_visibility_updated",
  "usage.organization_deleted",
  "usage.organization_deletion_requested",
  "usage.settings_updated",
  "team.member_role_changed",
  "team.policy_updated",
  "team.member_policy_updated",
  "team.member_policy_reset",
  "organization.policy_updated",
  "member.policy_updated",
  "member.policy_reset",
  "member.role_changed",
  "member.removed",
  "invitation.created",
  "invitation.regenerated",
  "invitation.revoked",
  "invitation.accepted",
  "device.enrolled",
  "device.revoked",
  "device.disconnected",
] as const;

function actionLabel(action: string): string {
  const words = action.replaceAll(".", " ").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function auditUrl({ action, offset, query }: { action: string; offset: number; query: string }) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (action) params.set("action", action);
  if (offset > 0) params.set("offset", String(offset));
  const suffix = params.toString();
  return suffix ? `/audit?${suffix}` : "/audit";
}

function exportUrl(action: string, query: string): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (action) params.set("action", action);
  const suffix = params.toString();
  return `/api/v1/admin/audit-events/export.csv${suffix ? `?${suffix}` : ""}`;
}

function auditTime(value: string): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

export function AuditEventsList({
  action,
  query,
  response,
}: {
  action: string;
  query: string;
  response: AuditEventsResponse;
}) {
  const { pageInfo } = response;
  const previousOffset = Math.max(0, pageInfo.offset - pageInfo.limit);
  const nextOffset = pageInfo.offset + pageInfo.limit;

  return (
    <Section
      action={
        <Button asChild size="sm" variant="outline">
          <a href={exportUrl(action, query)}>
            <DownloadIcon aria-hidden />
            Export CSV
          </a>
        </Button>
      }
      description="Search security and administration activity recorded for this organization. CSV exports include the current filters and up to 5,000 events."
      title="Activity"
    >
      <form className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto]" method="get">
        <Input
          aria-label="Search audit activity"
          defaultValue={query}
          name="q"
          placeholder="Search actor, action, or resource…"
        />
        <SelectWrapper>
          <Select aria-label="Filter by action" defaultValue={action} name="action">
            <option value="">All actions</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </SelectWrapper>
        <Button type="submit" variant="outline">Filter</Button>
      </form>

      <Panel>
        {response.events.length === 0 ? (
          <EmptyState
            description="No activity matches the current filters."
            icon={ScrollTextIcon}
            title="No audit events found"
          />
        ) : (
          <ol className="divide-y divide-border">
            {response.events.map((event) => (
              <li className="space-y-3 px-4 py-4 sm:px-5" key={event.id}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{actionLabel(event.action)}</Badge>
                      {event.subjectType && event.subjectId ? (
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {event.subjectType} · {event.subjectId}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                      {event.actor ? (
                        <>
                          <span className="font-medium text-foreground">{event.actor.name}</span>
                          <span className="break-all text-xs text-muted-foreground">{event.actor.email}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">System activity</span>
                      )}
                    </div>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={event.createdAt}>
                    {auditTime(event.createdAt)}
                  </time>
                </div>
                {Object.keys(event.metadata).length > 0 ? (
                  <details className="group text-xs text-muted-foreground">
                    <summary className="inline-flex min-h-11 cursor-pointer select-none items-center gap-1.5 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:min-h-0">
                      <ChevronDownIcon
                        aria-hidden
                        className="size-3.5 transition-transform group-open:rotate-180"
                      />
                      Event details
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs leading-relaxed text-secondary-foreground">
                      {JSON.stringify(event.metadata, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs tabular-nums text-muted-foreground">
          {pageInfo.total === 0
            ? "0 events"
            : `${pageInfo.offset + 1}–${Math.min(pageInfo.offset + response.events.length, pageInfo.total)} of ${pageInfo.total}`}
        </p>
        <div className="flex gap-2">
          <Button asChild={pageInfo.offset > 0} disabled={pageInfo.offset === 0} size="sm" variant="outline">
            {pageInfo.offset > 0 ? (
              <Link href={auditUrl({ action, offset: previousOffset, query })}>Previous</Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>
          <Button asChild={pageInfo.hasMore} disabled={!pageInfo.hasMore} size="sm" variant="outline">
            {pageInfo.hasMore ? (
              <Link href={auditUrl({ action, offset: nextOffset, query })}>Next</Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      </div>
    </Section>
  );
}
