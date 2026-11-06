"use client";
import { useEffect, useState } from "react";
import type { CloudProject, CloudProjectDetail } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { projectField } from "./project-ui";
export function ProjectDetailsForm({ project, active, onChanged, onDirtyChange, onBusyChange }: { project: CloudProject; active: boolean; onChanged: () => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const [baseline, setBaseline] = useState({ name: project.name, description: project.description, revision: project.revision, instructions: "" });
  const [name, setName] = useState(project.name), [description, setDescription] = useState(project.description), [instructions, setInstructions] = useState(""), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const canEditInstructions = project.access.actions.includes("instructions.write");
  useEffect(() => { if (!canEditInstructions) { setInstructions(""); setBaseline(value => ({ ...value, instructions: "" })); setLoaded(false); } }, [canEditInstructions]);
  const dirty = name !== baseline.name || description !== baseline.description || instructions !== baseline.instructions;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!active || !canEditInstructions || loaded || dirty) return;
    const controller = new AbortController();
    void cloudApi<CloudProjectDetail>(`/projects/${project.id}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setBaseline({ name: value.name, description: value.description, revision: value.revision, instructions: value.instructions }); setName(value.name); setDescription(value.description); setInstructions(value.instructions); setLoaded(true); } }).catch(f => { if (!controller.signal.aborted) setError(cloudError(f)); });
    return () => controller.abort();
  }, [active, canEditInstructions, loaded, dirty, project.id]);
  useEffect(() => { if (!dirty && baseline.revision < project.revision) { setBaseline(value => ({ ...value, name: project.name, description: project.description, revision: project.revision })); setName(project.name); setDescription(project.description); setLoaded(false); } }, [project, dirty, baseline.revision]);
  return <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (busy || project.status !== "active") return; setBusy(true); setError(""); try { const saved = await cloudApi<{ revision: number }>(`/projects/${project.id}`, cloudMutation({ name, description, ...(canEditInstructions && loaded ? { instructions } : {}), expectedRevision: baseline.revision }, "PATCH")); setBaseline({ name, description, instructions, revision: saved.revision }); onChanged(); } catch (f) { setError(cloudError(f)); } finally { setBusy(false); } }}>
    <label className="grid gap-2 text-sm">Project name<input className={projectField} value={name} maxLength={100} required disabled={busy || project.status !== "active"} onChange={e => setName(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Description<textarea className={projectField} value={description} maxLength={2000} disabled={busy || project.status !== "active"} onChange={e => setDescription(e.target.value)} /></label>
    {canEditInstructions && loaded ? <label className="grid gap-2 text-sm">Project instructions<textarea className={`${projectField} min-h-32`} value={instructions} maxLength={12000} disabled={busy} onChange={e => setInstructions(e.target.value)} /></label> : <p className="text-xs text-muted-foreground">Project instructions require an explicit project grant with instruction-editing permission.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {dirty && baseline.revision !== project.revision && <p role="status" className="text-xs text-muted-foreground">This project changed elsewhere. <button type="button" className="underline" onClick={() => { if (window.confirm("Discard unsaved details and reload?")) { setBaseline({ name: project.name, description: project.description, revision: project.revision, instructions: "" }); setName(project.name); setDescription(project.description); setInstructions(""); setLoaded(false); } }}>Reload saved details</button></p>}
    <Button size="sm" disabled={busy || !dirty || !name.trim() || project.status !== "active" || baseline.revision !== project.revision}>Save details</Button>
  </form>;
}
