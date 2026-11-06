import {
  ArrowRightIcon,
  BotIcon,
  BriefcaseBusinessIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { OpenLoriControl } from "@/components/open-lori-control";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, isPersonalWorkspace, roleLabel } from "@/lib/authority";
import { getSetupStatus, getViewer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const [{ source }, { status, viewer }, setup] = await Promise.all([
    searchParams,
    getViewer(),
    getSetupStatus(),
  ]);
  if (!viewer) {
    redirect(apiFailureDestination(status));
  }

  const cloud = setup?.publicSignup === true;
  const personal = isPersonalWorkspace(viewer);
  const newAccount = source === "signup";

  return (
    <AuthFrame
      cloud={cloud}
      description={
        personal
          ? "You’re in your personal workspace."
          : `Your account is active in ${viewer.organization.name}.`
      }
      title={
        source === "setup"
          ? "Organization setup complete"
          : newAccount
            ? "Your account is ready"
            : cloud
              ? "Welcome to Lori"
              : "Welcome to Lori Enterprise"
      }
    >
      <div className="space-y-5">
        <dl className="divide-y divide-border border-y border-border text-sm">
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd className="truncate text-right font-medium text-foreground">
              {viewer.user.email}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-muted-foreground">
              {personal ? "Account" : "Role"}
            </dt>
            <dd>
              <Badge variant="outline">
                {personal ? "Individual" : roleLabel(viewer.role)}
              </Badge>
            </dd>
          </div>
        </dl>

        {(source === "setup" || newAccount) && (
          <Alert className="text-xs leading-relaxed" variant="warning">
            Password recovery email is not enabled. Save your password in a
            password manager
            {personal ? "." : " before inviting members."}
          </Alert>
        )}

        {source === "invitation" && cloud && (
          <Alert className="text-xs leading-relaxed">
            You now have access to {viewer.organization.name}. Anything in a
            personal workspace stays private to you. Switch between workspaces
            from the account menu.
          </Alert>
        )}

        {/* A new account can do nothing in Work until it has a model. */}
        {isAdministrator(viewer) && (newAccount || personal) && (
          <Button asChild className="w-full" size="lg">
            <Link href="/work?section=providers">
              <BotIcon className="size-4" />
              Add your AI provider
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        )}

        {personal ? (
          <Button asChild className="w-full" size="lg" variant="outline">
            <Link href="/work/cloud">
              <BriefcaseBusinessIcon className="size-4" />
              Open Lori Work
            </Link>
          </Button>
        ) : isAdministrator(viewer) ? (
          <Button
            asChild
            className="w-full"
            size="lg"
            variant={newAccount ? "outline" : "default"}
          >
            <Link href="/people">
              <UsersIcon className="size-4" />
              Invite your first member
              {!newAccount && <ArrowRightIcon className="size-4" />}
            </Link>
          </Button>
        ) : null}

        <OpenLoriControl
          label={isAdministrator(viewer) ? "Connect Lori desktop" : "Open Lori desktop and connect"}
          publicUrl={setup?.publicUrl ?? ""}
          variant={isAdministrator(viewer) && (newAccount || personal) ? "outline" : "default"}
        />
        <Button asChild className="w-full" variant="ghost">
          <Link href="/">Open dashboard</Link>
        </Button>
      </div>
    </AuthFrame>
  );
}
