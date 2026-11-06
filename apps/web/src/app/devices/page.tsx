import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator } from "@/lib/authority";
import { getDevices, getSetupStatus, getViewer } from "@/lib/server-api";
import { DeviceManager } from "./device-manager";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  const organizationWide = isAdministrator(viewer);
  const [{ devices, status }, setup] = await Promise.all([
    getDevices(organizationWide),
    getSetupStatus(),
  ]);
  if (!devices) {
    redirect(apiFailureDestination(status));
  }

  return (
    <AppShell current="devices" viewer={viewer}>
      <div className="space-y-6">
        <PageHeader
          description="Review Lori desktop connections and revoke access immediately. Each device receives its own rotating credentials and access settings snapshot."
          title="Devices"
        />
        <DeviceManager
          initialDevices={devices.devices}
          organizationWide={organizationWide}
          publicUrl={setup?.publicUrl ?? ""}
        />
      </div>
    </AppShell>
  );
}
