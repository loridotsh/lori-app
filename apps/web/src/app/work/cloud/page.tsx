import { redirect } from "next/navigation";
import { ProjectWorkHome } from "@/components/work/cloud/projects/project-home";
import { getCloudAvailability, getViewer } from "@/lib/server-api";
import { apiFailureDestination } from "@/lib/api-failure-destination";

export const dynamic = "force-dynamic";

export default async function CloudWorkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const callbackQuery = new URLSearchParams();
  for (const key of ["project", "conversation"]) {
    const value = params[key];
    if (typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) callbackQuery.set(key, value);
  }
  const callback = `/work/cloud${callbackQuery.size ? `?${callbackQuery}` : ""}`;
  const { viewer, status } = await getViewer();
  if (!viewer)
    redirect(
      status === 401
        ? `/sign-in?callback=${encodeURIComponent(callback)}`
        : apiFailureDestination(status),
    );
  // Work access is the single switch. When it is off, leave before anything
  // renders; the API independently refuses every Cloud Work operation.
  const availability = await getCloudAvailability();
  if (availability.enabled === false) redirect("/work?cloud=off");
  return <ProjectWorkHome viewer={viewer} />;
}
