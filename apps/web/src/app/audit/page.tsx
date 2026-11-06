import { redirect } from "next/navigation";
import { AuditEventsList } from "@/app/audit/audit-events-list";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { getAuditEvents, getViewer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

function value(input: string | string[] | undefined): string {
  return (Array.isArray(input) ? (input[0] ?? "") : input ?? "")
    .trim()
    .slice(0, 200);
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ status: viewerStatus, viewer }, params] = await Promise.all([
    getViewer(),
    searchParams,
  ]);
  if (!viewer) redirect(apiFailureDestination(viewerStatus));
  // The audit log records what people do to each other's access.
  if (isPersonalWorkspace(viewer)) redirect("/");
  if (!isAdministrator(viewer)) redirect("/unauthorized");

  const query = value(params.q);
  const action = value(params.action);
  const parsedOffset = Number.parseInt(value(params.offset), 10);
  const offset = Number.isSafeInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const { audit, status } = await getAuditEvents({ action, offset, query });
  if (!audit) redirect(apiFailureDestination(status));

  return (
    <AppShell current="audit" viewer={viewer}>
      <div className="space-y-6">
        <PageHeader
          description="Trace policy, membership, invitation, and device changes across your organization."
          title="Audit log"
        />
        <AuditEventsList action={action} query={query} response={audit} />
      </div>
    </AppShell>
  );
}
