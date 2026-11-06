"use client";

import { useEffect, useState } from "react";
import type { CloudConversation, PersonalProject } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cloudError } from "@/lib/cloud-work-api";
import { moveConversationToProject } from "@/lib/personal-projects-api";

/** Files a private chat into, between or out of the member's personal projects. The chat itself is unchanged. */
export function MoveConversationDialog({
  open,
  conversation,
  projects,
  onClose,
  onMoved,
}: {
  open: boolean;
  conversation: Pick<CloudConversation, "id" | "title" | "revision" | "personalProjectId">;
  projects: PersonalProject[];
  onClose: () => void;
  onMoved: (conversation: CloudConversation) => void;
}) {
  const current = conversation.personalProjectId ?? "";
  const [choice, setChoice] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open) {
      setChoice(current);
      setError("");
      setRequestId(crypto.randomUUID());
    }
  }, [open, current, conversation.id]);
  const targets = projects.filter((project) => project.status === "active" || project.id === current);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="Move to project" description="Only you can see your personal projects. The chat keeps its messages, files and notes.">
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || choice === current) return;
          setBusy(true);
          setError("");
          try {
            const moved = await moveConversationToProject(conversation.id, { requestId, personalProjectId: choice || null, expectedRevision: conversation.revision });
            onMoved(moved);
            onClose();
          } catch (failure) {
            setError(cloudError(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="space-y-1" disabled={busy}>
          <legend className="sr-only">Destination for {conversation.title}</legend>
          <label className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-secondary">
            <input type="radio" name="personal-project" value="" checked={choice === ""} onChange={() => setChoice("")} />
            No project (Conversations)
          </label>
          {targets.map((project) => (
            <label key={project.id} className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-secondary">
              <input type="radio" name="personal-project" value={project.id} checked={choice === project.id} onChange={() => setChoice(project.id)} />
              <span className="min-w-0 truncate">{project.name}</span>
            </label>
          ))}
          {!targets.length && <p className="px-2 text-xs text-muted-foreground">You have no personal projects yet.</p>}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || choice === current}>{busy ? "Moving…" : "Move"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
