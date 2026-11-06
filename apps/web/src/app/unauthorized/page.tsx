import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WorkspaceSelect } from "@/components/workspace-select";
import { getViewer, getWorkspaces } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function UnauthorizedPage() {
  const [{ workspaces }, { viewer }] = await Promise.all([
    getWorkspaces(),
    getViewer(),
  ]);
  // A new or removed person has no workspace to be refused from: every page
  // sends them here, and this one sends them on to create one.
  if (workspaces?.canCreate && workspaces.workspaces.length === 0) {
    redirect("/get-started");
  }

  const several = (workspaces?.workspaces.length ?? 0) > 1;
  return (
    <AuthFrame
      cloud={viewer?.cloud}
      description={
        viewer
          ? `You’re signed in to ${viewer.organization.name}, where this page isn’t available.`
          : "You are signed in, but your account does not have permission to open this page."
      }
      title="Access required"
    >
      <div className="space-y-4">
        <Alert variant="warning">
          {several
            ? "It may belong to another workspace, or need access you don’t have in this one."
            : "Ask an administrator to check your organization membership and access to this page, or return to a page available to your role."}
        </Alert>
        {several && workspaces && (
          <WorkspaceSelect
            destination="/"
            label="Switch workspace"
            workspaces={workspaces.workspaces}
          />
        )}
        <Button asChild className="w-full" variant="outline">
          <Link href={viewer ? "/" : "/sign-in"}>
            {viewer ? "Back to dashboard" : "Return to sign in"}
          </Link>
        </Button>
      </div>
    </AuthFrame>
  );
}
