"use client";
import { useEffect, useRef, useState } from "react";
import type { CloudProjectDetail } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { projectField } from "../cloud/projects/project-ui";

export function CreateManagedProject({ open, allowed, onClose, onCreated }: { open: boolean; allowed: boolean; onClose: () => void; onCreated: (project: CloudProjectDetail) => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false);
  const requestId = useRef("");
  useEffect(() => { if (open) { requestId.current = crypto.randomUUID(); setName(""); setDescription(""); setInstructions(""); setError(""); setUncertain(false); } }, [open]);
  const disabled = busy || !allowed || uncertain;
  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title="Create project" description="Create a shared workspace, then assign its members, teams, and permissions in Manage.">
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); if (busy || !allowed || !name.trim()) return;
      setBusy(true); setError("");
      try {
        const project = await cloudApi<CloudProjectDetail>("/projects", cloudMutation({ requestId: requestId.current, name: name.trim(), description: description.trim(), instructions }));
        setUncertain(false); onCreated(project);
      } catch (failure) {
        setError(cloudError(failure));
        setUncertain(failure instanceof ClientApiError && (failure.status === 0 || failure.status >= 500));
      } finally { setBusy(false); }
    }}>
      <label className="grid gap-2 text-sm">Project name<input autoFocus className={projectField} maxLength={100} required value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
      <label className="grid gap-2 text-sm">Description<textarea className={projectField} maxLength={2000} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} /></label>
      <label className="grid gap-2 text-sm">Project instructions<textarea className={`${projectField} min-h-28`} maxLength={12000} value={instructions} disabled={disabled} onChange={event => setInstructions(event.target.value)} /><span className="text-xs leading-5 text-muted-foreground">Optional project context. Existing organization permissions and approval rules apply.</span></label>
      {!allowed && <p role="status" className="text-xs text-muted-foreground">Creation is currently unavailable. Your draft is retained.</p>}
      {uncertain && <p role="status" className="text-xs leading-5 text-muted-foreground">Creation may already have succeeded. Retry to confirm the same request.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !allowed || !name.trim()}>{busy ? "Creating…" : uncertain ? "Retry creation" : "Create project"}</Button></div>
    </form>
  </Dialog>;
}
