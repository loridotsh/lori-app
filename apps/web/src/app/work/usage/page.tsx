import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { UsageDashboard } from "@/app/usage/usage-dashboard";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { getViewer } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export default async function WorkUsagePage() {
  const { viewer, status } = await getViewer();
  if (!viewer) redirect(apiFailureDestination(status));
  if (!viewer.usageAnalytics?.canView) redirect("/unauthorized");
  return (
    <AppShell current="work" viewer={viewer} wide>
      <Suspense fallback={<p role="status">Loading Work usage…</p>}>
        <UsageDashboard viewer={viewer} product="work" />
      </Suspense>
    </AppShell>
  );
}
