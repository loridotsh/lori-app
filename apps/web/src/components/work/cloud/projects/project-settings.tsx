"use client";

import { useEffect, useState } from "react";
import type { CloudProjectDetail, ProjectPolicy } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { CloudExtensions } from "../cloud-extensions";
import { ProjectMembers } from "./project-members";
import { ProjectMemoryPanel } from "./project-memory";
import { ProjectPolicyControls } from "./project-policy-controls";
import { projectField } from "./project-ui";

export const settings: { key: keyof Pick<ProjectPolicy, "memoryEnabled" | "forceAskMe" | "exportsAllowed" | "externalWritesAllowed" | "managersManageMembers" | "managersManageConnections">; label: string; description: string }[] = [
  { key: "memoryEnabled", label: "Project memory", description: "Recall notes and relevant sources from this project." },
  { key: "forceAskMe", label: "Require Ask me", description: "Require a decision before proposed changes and external actions." },
  { key: "exportsAllowed", label: "Allow downloads", description: "Members with export permission can download project files." },
  { key: "externalWritesAllowed", label: "Allow external changes", description: "Allow authorized members to request changes through project connections." },
  { key: "managersManageMembers", label: "Delegate access management", description: "Project managers can manage access within their permissions." },
  { key: "managersManageConnections", label: "Delegate connection management", description: "Project managers can configure accounts dedicated to this project." },
];
export function ProjectSettings({ project, admin, onChanged, onDirtyChange, onBusyChange }: { project: CloudProjectDetail; admin: boolean; onChanged: () => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const [tab, setTab] = useState("general"), [connectionsBusy, setConnectionsBusy] = useState(false);
  const [baseline, setBaseline] = useState(project);
  const [name, setName] = useState(project.name), [description, setDescription] = useState(project.description), [instructions, setInstructions] = useState(project.instructions);
  const [policy, setPolicy] = useState(project.policy);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [membersDirty, setMembersDirty] = useState(false), [memoryDirty, setMemoryDirty] = useState(false), [membersBusy, setMembersBusy] = useState(false), [memoryBusy, setMemoryBusy] = useState(false);
  const ownDirty = name !== baseline.name || description !== baseline.description || instructions !== baseline.instructions || JSON.stringify(policy) !== JSON.stringify(baseline.policy);
  const dirty = ownDirty || membersDirty || memoryDirty;
  const editable = project.status === "active" && (admin || project.access.actions.includes("instructions.write"));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || membersBusy || memoryBusy || connectionsBusy); return () => onBusyChange(false); }, [busy, membersBusy, memoryBusy, connectionsBusy, onBusyChange]);
  useEffect(() => {
    if (!ownDirty && baseline.revision < project.revision) { setBaseline(project); setName(project.name); setDescription(project.description); setInstructions(project.instructions); setPolicy(project.policy); }
  }, [project, ownDirty, baseline.revision]);
  const lifecycle = async (status: "active" | "archived" | "deleted") => {
    if (dirty && !window.confirm("Discard your unsaved settings changes?")) return;
    if (status === "deleted" && !window.confirm("Delete this project for everyone? Recovery is available for up to 30 days, subject to your organization’s retention policy.")) return;
    setBusy(true); setError("");
    try { await cloudApi(`/projects/${project.id}/lifecycle`, cloudMutation({ status, expectedRevision: project.revision })); onChanged(); }
    catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <nav aria-label="Project settings sections" className="flex flex-wrap gap-1 border-b border-border pb-2">{["general", ...(admin || project.access.actions.includes("members.manage") ? ["access"] : []), ...(admin || project.access.actions.includes("connections.manage") ? ["connections"] : []), "memory"].map(item => <button type="button" key={item} aria-current={tab === item ? "page" : undefined} disabled={busy || membersBusy || memoryBusy || connectionsBusy} onClick={() => setTab(item)} className={`rounded-md px-3 py-2 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/60"}`}>{item}</button>)}</nav>
    <section hidden={tab !== "general"} className="space-y-4" aria-label="Project details">
      <div><h3 className="text-sm font-semibold">{project.name}</h3><p className="mt-1 text-xs text-muted-foreground">{project.access.source === "organization_admin" ? "Organization admin access" : project.access.audited ? "Audited administrator access · read only" : `${project.access.role ?? "Member"} access`} · {project.status === "archived" ? "Archived" : "Project-only context"}</p></div>
      {!editable && <p className="text-xs text-muted-foreground">Project details are read only for your role.</p>}
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (!editable || busy) return; setBusy(true); setError(""); try { const result = await cloudApi<{ revision: number }>(`/projects/${project.id}`, cloudMutation({ name, description, instructions, ...(admin ? { policy } : {}), expectedRevision: baseline.revision }, "PATCH")); setBaseline({ ...baseline, name, description, instructions, policy, revision: result.revision }); onChanged(); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>
        <label className="grid gap-2 text-sm">Name<input className={projectField} maxLength={100} value={name} onChange={e => setName(e.target.value)} readOnly={!editable} disabled={busy} required /></label>
        <label className="grid gap-2 text-sm">Description<textarea className={projectField} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} readOnly={!editable} disabled={busy} /></label>
        <label className="grid gap-2 text-sm">Project instructions<textarea className={`${projectField} min-h-36`} maxLength={12000} value={instructions} onChange={e => setInstructions(e.target.value)} readOnly={!editable} disabled={busy} /><span className="text-xs leading-5 text-muted-foreground">Guide how Lori works on this project. Organization permissions and approval rules still apply.</span></label>
        {admin && <details className="space-y-4"><summary className="cursor-pointer text-sm font-medium">Project permissions</summary><ProjectPolicyControls policy={policy} onChange={setPolicy} disabled={busy || project.status !== "active"} /></details>}
        {ownDirty && baseline.revision !== project.revision && <p role="status" className="text-sm text-muted-foreground">Settings changed elsewhere. Reload before saving your changes.</p>}
        {editable && <div className="flex gap-2"><Button disabled={busy || !ownDirty || !name.trim()}>Save project</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { if (!ownDirty || window.confirm("Discard unsaved project settings?")) { setBaseline(project); setName(project.name); setDescription(project.description); setInstructions(project.instructions); setPolicy(project.policy); } }}>Reload</Button></div>}
      </form>
      {admin && <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void lifecycle(project.status === "archived" ? "active" : "archived")}>{project.status === "archived" ? "Restore project" : "Archive project"}</Button><Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => void lifecycle("deleted")}>Delete project</Button></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
    <div hidden={tab !== "access"}>{project.status === "active" && (admin || project.access.actions.includes("members.manage")) && <ProjectMembers projectId={project.id} admin={admin} onDirtyChange={setMembersDirty} onBusyChange={setMembersBusy} onSaved={onChanged} />}</div>
    {tab === "connections" && project.status === "active" && (admin || project.access.actions.includes("connections.manage")) && <CloudExtensions projectId={project.id} management onFailure={f => setError(cloudError(f))} onBusyChange={setConnectionsBusy} />}
    <div hidden={tab !== "memory"}><ProjectMemoryPanel project={project} onDirtyChange={setMemoryDirty} onBusyChange={setMemoryBusy} /></div>
  </div>;
}
