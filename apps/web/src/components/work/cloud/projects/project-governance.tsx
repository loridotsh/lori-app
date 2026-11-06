"use client";
import { useEffect, useState } from "react";
import type { CloudProject, ProjectPolicy } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { ProjectMembers } from "./project-members";
import { ProjectPolicyControls } from "./project-policy-controls";
import { ProjectDetailsForm } from "./project-details-form";
import { CloudExtensions } from "../cloud-extensions";
export function ProjectGovernance({ project, onChanged, onDirtyChange, onBusyChange }: { project: CloudProject; onChanged: () => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const [detailsDirty, setDetailsDirty] = useState(false), [detailsBusy, setDetailsBusy] = useState(false);
  const [tab, setTab] = useState("access"), [connectionsBusy, setConnectionsBusy] = useState(false);
  const [baseline, setBaseline] = useState<{ revision: number; policy: ProjectPolicy } | null>(null), [policy, setPolicy] = useState<ProjectPolicy | null>(null);
  const [busy, setBusy] = useState(false), [membersBusy, setMembersBusy] = useState(false), [membersDirty, setMembersDirty] = useState(false), [error, setError] = useState("");
  const dirty = !!baseline && JSON.stringify(policy) !== JSON.stringify(baseline.policy);
  useEffect(() => { if (dirty) return; let alive = true; void cloudApi<{ revision: number; policy: ProjectPolicy }>(`/projects/${project.id}/governance`).then(value => { if (alive) { setBaseline(value); setPolicy(value.policy); } }).catch(f => { if (alive) setError(cloudError(f)); }); return () => { alive = false; }; }, [project.id, project.revision, dirty]);
  useEffect(() => { onDirtyChange(dirty || membersDirty || detailsDirty); return () => onDirtyChange(false); }, [dirty, membersDirty, detailsDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || membersBusy || connectionsBusy || detailsBusy); return () => onBusyChange(false); }, [busy, membersBusy, connectionsBusy, detailsBusy, onBusyChange]);
  return <div className="space-y-4">
    <nav aria-label="Project management sections" className="flex flex-wrap gap-1 border-b border-border pb-2">{["general","access","permissions","connections","lifecycle"].map(item => <button type="button" key={item} aria-current={tab === item ? "page" : undefined} disabled={connectionsBusy || busy || membersBusy || detailsBusy} onClick={() => setTab(item)} className={`rounded-md px-3 py-2 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/60"}`}>{item}</button>)}</nav>
    <p className="text-xs leading-5 text-muted-foreground">{tab === "general" ? "Manage project details. Instructions use your explicit project permissions." : tab === "connections" ? "Configure project-dedicated connections. Personal accounts are never inherited." : "Manage permissions and lifecycle without opening project content."}</p>
    <div hidden={tab !== "general"}><ProjectDetailsForm project={project} active={tab === "general"} onChanged={onChanged} onDirtyChange={setDetailsDirty} onBusyChange={setDetailsBusy} /></div>
    {policy && baseline && <form hidden={tab !== "permissions"} className="space-y-3" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); try { const saved = await cloudApi<{ revision: number }>(`/projects/${project.id}`, cloudMutation({ policy, expectedRevision: baseline.revision }, "PATCH")); setBaseline({ ...saved, policy }); onChanged(); } catch (f) { setError(cloudError(f)); } finally { setBusy(false); } }}>
      <ProjectPolicyControls policy={policy} onChange={setPolicy} disabled={busy || project.status !== "active"} />
      {baseline.revision !== project.revision && <p role="status" className="text-xs text-muted-foreground">Settings changed elsewhere. <button type="button" className="underline" onClick={() => { if (window.confirm("Discard your unsaved permission edits and reload?")) setPolicy(baseline.policy); }}>Reload saved settings</button></p>}
      <Button disabled={busy || baseline.revision !== project.revision || !dirty || project.status !== "active"}>Save permissions</Button>
    </form>}
    <div hidden={tab !== "access"}>{project.status === "active" ? <ProjectMembers key={project.id} projectId={project.id} admin onDirtyChange={setMembersDirty} onBusyChange={setMembersBusy} onSaved={onChanged} /> : <p className="text-sm text-muted-foreground">Restore the project before changing access.</p>}</div>
    {tab === "connections" && project.status === "active" && <CloudExtensions projectId={project.id} management onFailure={f => setError(cloudError(f))} onBusyChange={setConnectionsBusy} />}
    <div hidden={tab !== "lifecycle"}><p className="mb-3 text-xs leading-5 text-muted-foreground">Archiving keeps content readable and stops changes. Deleted projects can be recovered for up to 30 days, bounded by organization retention.</p><div className="flex gap-2">{([project.status === "active" ? "archived" : "active", "deleted"] as const).map(status => <Button key={status} variant="outline" disabled={busy || membersBusy || detailsBusy || dirty || membersDirty || detailsDirty || status === project.status} onClick={async () => { if (!baseline || !window.confirm(`${status === "deleted" ? "Delete" : status === "archived" ? "Archive" : "Restore"} this project?`)) return; setBusy(true); try { await cloudApi(`/projects/${project.id}/lifecycle`, cloudMutation({ status, expectedRevision: baseline.revision })); onChanged(); } catch (f) { setError(cloudError(f)); } finally { setBusy(false); } }}>{status === "deleted" ? "Delete project" : status === "archived" ? "Archive project" : "Restore project"}</Button>)}</div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
