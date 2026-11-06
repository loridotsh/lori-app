"use client";

import type { Viewer, Workspace } from "@lori-enterprise/contracts";
import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectWrapper } from "@/components/ui/select";
import { clientApi } from "@/lib/client-api";
import { announceWorkspaceChange } from "@/lib/workspace-channel";

/** Moves this browser session to another workspace, then reloads what it shows. */
export function WorkspaceSelect({
  destination,
  label,
  workspaces,
}: {
  /** Where to go afterwards; without one the current page reloads. */
  destination?: string;
  label: string;
  workspaces: Workspace[];
}) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const active = workspaces.find((workspace) => workspace.active)?.id ?? "";

  async function change(organizationId: string) {
    setPending(true);
    setError(false);
    try {
      await clientApi<Viewer>("/v1/workspaces/active", {
        body: JSON.stringify({ organizationId }),
        method: "POST",
      });
      announceWorkspaceChange();
      if (destination) window.location.assign(destination);
      else window.location.reload();
    } catch {
      setError(true);
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <SelectWrapper className="w-full">
        <Select
          disabled={pending}
          id={id}
          onChange={(event) => void change(event.target.value)}
          value={active}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
              {workspace.kind === "personal" ? " (just you)" : ""}
            </option>
          ))}
        </Select>
      </SelectWrapper>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          The workspace could not be changed. Try again.
        </p>
      )}
    </div>
  );
}
