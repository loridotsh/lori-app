import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { safeCallback } from "@/lib/safe-callback";
import { getWorkspaces } from "@/lib/server-api";
import { WorkspaceForm } from "./workspace-form";

export const dynamic = "force-dynamic";

/** Adds a workspace to an existing account, including one that has none left. */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ callback?: string }>;
}) {
  const { callback } = await searchParams;
  const { status, workspaces } = await getWorkspaces();
  if (!workspaces) {
    redirect(apiFailureDestination(status));
  }
  if (!workspaces.canCreate) {
    redirect("/");
  }

  const firstWorkspace = workspaces.workspaces.length === 0;
  return (
    <AuthFrame
      cloud
      description={
        firstWorkspace
          ? "Choose how you want to use Lori."
          : "Your existing workspaces stay as they are."
      }
      title={
        firstWorkspace
          ? "Set up your account"
          : workspaces.canCreatePersonal
            ? "Create a workspace"
            : "Create an organization"
      }
    >
      <WorkspaceForm
        callbackPath={safeCallback(callback)}
        canCancel={!firstWorkspace}
        canCreatePersonal={workspaces.canCreatePersonal}
      />
    </AuthFrame>
  );
}
