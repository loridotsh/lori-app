"use client";

import type {
  LeaveWorkspaceResult,
  Viewer,
  Workspace,
  WorkspacesResponse,
} from "@lori-enterprise/contracts";
import {
  Building2Icon,
  CheckIcon,
  DoorOpenIcon,
  LogOutIcon,
  PlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { clientApi } from "@/lib/client-api";
import { announceWorkspaceChange, onWorkspaceChange } from "@/lib/workspace-channel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The signed-in person's name, never the organization's. */
export function accountName(viewer: Viewer) {
  return viewer.user.name.trim() || viewer.user.email;
}

export function AccountMenu({
  viewer,
  compact = false,
}: {
  viewer: Viewer;
  compact?: boolean;
}) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspacesResponse | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  // The Owner hands the organization over first, from People.
  const canLeave =
    viewer.cloud === true &&
    viewer.organization.kind !== "personal" &&
    viewer.role !== "owner";
  const showWorkspaces =
    workspaces !== null &&
    (workspaces.canCreate || workspaces.workspaces.length > 1);

  useEffect(() => onWorkspaceChange(() => window.location.assign("/")), []);

  function loadWorkspaces(open: boolean) {
    if (!open) return;
    clientApi<WorkspacesResponse>("/v1/workspaces")
      .then(setWorkspaces)
      .catch(() => undefined);
  }

  async function switchWorkspace(workspace: Workspace) {
    if (workspace.active) return;
    try {
      await clientApi<Viewer>("/v1/workspaces/active", {
        body: JSON.stringify({ organizationId: workspace.id }),
        method: "POST",
      });
      announceWorkspaceChange();
    } catch {
      // Reload either way: the page then shows the workspace actually in use.
    }
    // A full load, so no data from the previous workspace stays in memory.
    window.location.assign(
      window.location.pathname.startsWith("/work/cloud") ? "/work/cloud" : "/",
    );
  }

  async function leave() {
    setLeaving(true);
    setLeaveError(null);
    try {
      await clientApi<LeaveWorkspaceResult>("/v1/workspaces/active/leave", {
        body: JSON.stringify({ organizationId: viewer.organization.id }),
        method: "POST",
      });
      announceWorkspaceChange();
      window.location.assign("/");
    } catch (failure) {
      setLeaveError(
        failure instanceof Error
          ? failure.message
          : "You could not leave this organization. Try again.",
      );
      setLeaving(false);
    }
  }

  async function signOut() {
    try {
      await authClient.signOut();
    } catch {
      // The server may be unreachable. Leave the signed-in view anyway; the
      // session cookie is rejected on the next request if it is still valid.
    }
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <>
    <DropdownMenu onOpenChange={loadWorkspaces}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Open account menu"
          className={
            compact
              ? "size-9 justify-center px-0"
              : "max-w-52 justify-start gap-2 px-1.5"
          }
          variant="ghost"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon className="size-3.5" />
          </span>
          <span
            className={
              compact ? "sr-only" : "hidden min-w-0 text-left sm:block"
            }
          >
            <span className="block truncate text-xs font-medium text-foreground">
              {accountName(viewer)}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {viewer.user.email}
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="space-y-1">
          <span className="block truncate text-sm font-semibold">
            {accountName(viewer)}
          </span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {viewer.user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {showWorkspaces && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Workspaces
            </DropdownMenuLabel>
            {workspaces.workspaces.map((workspace) => {
              const Icon = workspace.kind === "personal" ? UserRoundIcon : Building2Icon;
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  onSelect={() => void switchWorkspace(workspace)}
                >
                  <Icon />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {workspace.active && (
                    <CheckIcon aria-label="Current workspace" className="text-primary" />
                  )}
                </DropdownMenuItem>
              );
            })}
            {workspaces.canCreate && (
              <DropdownMenuItem onSelect={() => router.push("/get-started")}>
                <PlusIcon />
                Create a workspace
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        {viewer.organization.kind !== "personal" && (
          <>
            <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
              Organization role
              <Badge variant="outline" className="capitalize">
                {viewer.role}
              </Badge>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {canLeave && (
          <DropdownMenuItem onSelect={() => setConfirmLeave(true)}>
            <DoorOpenIcon />
            <span className="min-w-0 flex-1 truncate">
              Leave {viewer.organization.name}
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {canLeave && (
      <Dialog
        description="You lose access to its shared projects, and desktops connected to it are disconnected."
        onClose={() => {
          if (!leaving) {
            setConfirmLeave(false);
            setLeaveError(null);
          }
        }}
        open={confirmLeave}
        title={`Leave ${viewer.organization.name}?`}
      >
        <div className="space-y-4">
          {leaveError && <Alert variant="destructive">{leaveError}</Alert>}
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your private chats, memory and personal projects in this
            organization are permanently deleted. To return, you’ll need a new
            invitation.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={leaving}
              onClick={() => {
                setConfirmLeave(false);
                setLeaveError(null);
              }}
              type="button"
              variant="outline"
            >
              Stay
            </Button>
            <Button
              disabled={leaving}
              onClick={() => void leave()}
              type="button"
              variant="destructive"
            >
              {leaving ? "Leaving…" : "Leave organization"}
            </Button>
          </div>
        </div>
      </Dialog>
    )}
    </>
  );
}
