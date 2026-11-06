"use client";

import type { CreateWorkspaceInput, Viewer, WorkspaceKind } from "@lori-enterprise/contracts";
import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  AccountTypeFields,
  OrganizationNameField,
  OrganizationSlot,
} from "@/components/account-type-fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { clientApi } from "@/lib/client-api";
import { announceWorkspaceChange } from "@/lib/workspace-channel";

export function WorkspaceForm({
  callbackPath,
  canCancel,
  canCreatePersonal,
}: {
  callbackPath: string;
  canCancel: boolean;
  canCreatePersonal: boolean;
}) {
  const [kind, setKind] = useState<WorkspaceKind>(canCreatePersonal ? "personal" : "enterprise");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const workspace: CreateWorkspaceInput = kind === "enterprise"
      ? { kind, organizationName: String(form.get("organizationName") ?? "").trim() }
      : { kind };
    try {
      await clientApi<Viewer>("/v1/workspaces", {
        body: JSON.stringify(workspace),
        method: "POST",
      });
      announceWorkspaceChange();
      // A full load, so nothing from the previous workspace stays on screen.
      window.location.assign(callbackPath === "/" ? "/welcome?source=signup" : callbackPath);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The workspace could not be created.",
      );
      setPending(false);
    }
  }

  return (
    <form aria-busy={pending} className="space-y-5" onSubmit={submit}>
      {error && <Alert variant="destructive">{error}</Alert>}
      <fieldset className="min-w-0 space-y-4" disabled={pending}>
        <legend className="sr-only">Workspace details</legend>
        {canCreatePersonal ? (
          <>
            <AccountTypeFields kind={kind} onKindChange={setKind} />
            <OrganizationSlot kind={kind} />
          </>
        ) : (
          <div className="space-y-1.5">
            <OrganizationNameField />
          </div>
        )}
      </fieldset>
      <Button className="w-full" disabled={pending} type="submit">
        {pending
          ? "Creating…"
          : kind === "enterprise"
            ? "Create organization"
            : "Create personal workspace"}
      </Button>
      {canCancel && (
        <Button asChild className="w-full" variant="ghost">
          <Link href="/">Cancel</Link>
        </Button>
      )}
    </form>
  );
}
