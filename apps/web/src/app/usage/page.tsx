import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { getViewer } from "@/lib/server-api";
import { UsageDashboard } from "./usage-dashboard";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const { status, viewer } = await getViewer();
  if (!viewer) redirect(apiFailureDestination(status));
  if (!viewer.usageAnalytics?.canView) redirect("/unauthorized");

  return (
    <AppShell current="usage" viewer={viewer} wide>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" />}>
        <UsageDashboard viewer={viewer} />
      </Suspense>
    </AppShell>
  );
}
