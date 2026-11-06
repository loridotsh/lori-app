"use client";

import type { TeamPolicyPreview } from "@lori-enterprise/contracts";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function TeamPolicyPreviewDialog({
  onClose,
  onConfirm,
  open,
  pending,
  preview,
}: {
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
  preview: TeamPolicyPreview | null;
}) {
  return (
    <Dialog
      description="Review the direct team-policy changes before they are published to connected desktops."
      onClose={onClose}
      open={open}
      title="Review team policy changes"
    >
      {preview ? (
        <div className="space-y-4">
          <Alert variant="warning">
            Up to {preview.potentiallyAffectedMemberCount} team members may be
            affected. Removing a team grant does not revoke access still granted
            by the organization, another team, or a global member override.
          </Alert>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Catalog grants added</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {preview.catalogGrantsAdded}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Catalog grants removed</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {preview.catalogGrantsRemoved}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Personal grants added</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {preview.personalGrantsAdded}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Personal grants removed</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {preview.personalGrantsRemoved}
              </dd>
            </div>
          </dl>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              Keep editing
            </Button>
            <Button disabled={pending} onClick={onConfirm} type="button">
              {pending ? "Applying…" : "Apply changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
