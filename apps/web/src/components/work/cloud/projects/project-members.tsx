"use client";

import { useCallback, useEffect, useState } from "react";
import { PROJECT_ACTIONS, type ProjectAction, type ProjectEffectiveAccess, type ProjectGrant, type ProjectMemberships, type ProjectResourceAvailability, type WorkResourceDenialReason } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";

interface Directory { members: { id: string; name: string; email: string }[]; teams: { id: string; name: string }[] }
type Assignment = { kind: "member" | "team"; subjectId: string };
const key = (g: Assignment) => `${g.kind}:${g.subjectId}`;
const actionLabels: Record<ProjectAction, string> = { read: "Read project content", chat: "Start and continue chats", "files.write": "Upload and edit files", "files.delete": "Delete files", "memory.write": "Save and edit memory", "memory.delete": "Delete memory", "instructions.write": "Edit project instructions", "conversations.delete": "Delete conversations", export: "Download and export", "tools.use": "Use tools", "tools.write": "External tool writes", "runs.manage": "Cancel other members' runs", "approvals.manage": "Approve other members' actions", "connections.manage": "Manage project connections", "members.manage": "Manage project access" };
function Choice({ directory, value, onChange, disabled, assigned = [] }: { directory: Directory; value: string; onChange: (value: string) => void; disabled?: boolean; assigned?: string[] }) {
  const options: SearchSelectOption[] = [
    ...directory.members.map(m => ({ value: `member:${m.id}`, label: m.name, description: `${assigned.includes(`member:${m.id}`) ? "Already added · " : ""}${m.email}`, group: "Members", disabled: assigned.includes(`member:${m.id}`) })),
    ...directory.teams.map(t => ({ value: `team:${t.id}`, label: t.name, description: assigned.includes(`team:${t.id}`) ? "Already added" : "All members of this team", group: "Teams", disabled: assigned.includes(`team:${t.id}`) })),
  ];
  return <SearchSelect label="Member or team" placeholder="Choose a member or team" searchPlaceholder="Search name, email, or team…" value={value} onChange={onChange} disabled={disabled} options={options} className="flex-1" />;
}
const roleOptions: SearchSelectOption[] = [
  { value: "viewer", label: "Viewer", description: "Read shared conversations, files, and memory" },
  { value: "contributor", label: "Contributor", description: "Create conversations and edit shared work" },
  { value: "manager", label: "Manager", description: "Manage work within delegated permissions" },
];
function assignment(value: string): Assignment { const split = value.indexOf(":"); return { kind: value.slice(0, split) as Assignment["kind"], subjectId: value.slice(split + 1) }; }
function label(directory: Directory, grant: Assignment) { return (grant.kind === "member" ? directory.members : directory.teams).find(item => item.id === grant.subjectId)?.name ?? "Unavailable member or team"; }

const denialLabels: Record<WorkResourceDenialReason, string> = {
  work_disabled: "Work is off for this member",
  not_assigned: "not assigned to this member",
  not_assigned_to_project: "not assigned to this project",
  not_approved: "not approved by the organization",
  member_restricted: "blocked for this member",
  not_connected: "no company connection",
};
function ResourceList({ title, items }: { title: string; items: (ProjectResourceAvailability & { providerName?: string })[] }) {
  const allowed = items.filter(item => item.allowed), unavailable = items.filter(item => !item.allowed && item.reason !== "not_assigned" && item.reason !== "not_assigned_to_project");
  return <div><p className="font-medium">{title}</p>{allowed.length ? <p className="text-muted-foreground">{allowed.map(item => `${item.providerName ? `${item.providerName} · ` : ""}${item.name}${item.source === "project_assignment" ? " (project)" : ""}`).join(", ")}</p> : <p className="text-muted-foreground">None available</p>}{unavailable.length > 0 && <ul className="mt-1 text-muted-foreground">{unavailable.map(item => <li key={`${item.providerName ?? ""}:${item.id}`}>{item.providerName ? `${item.providerName} · ` : ""}{item.name}: {denialLabels[item.reason!]}</li>)}</ul>}</div>;
}
function EffectiveAccess({ preview, directory }: { preview: ProjectEffectiveAccess; directory: Directory }) {
  const status = preview.administrator ? "Organization admin: full project access" : preview.blocked ? "Explicitly blocked" : !preview.workEnabled ? "Enterprise Work disabled" : preview.access.actions.length ? "Permitted project actions" : "No project access";
  return <div className="space-y-3 text-xs">
    <p className="font-medium">{status}</p>
    <p>{preview.access.actions.map(action => actionLabels[action]).join(" · ")}</p>
    {preview.sources.length > 0 && <ul>{preview.sources.map(source => <li key={key(source)}>{label(directory, source)} ({source.kind}) · {source.role}{source.deniedActions.length ? ` · ${source.deniedActions.length} restrictions` : ""}</li>)}</ul>}
    {preview.resources && preview.access.actions.length > 0 && <div className="space-y-2 border-t border-border pt-2">
      <ResourceList title={`Models (${preview.resources.providerMode === "assigned" ? "assigned to this project" : "member's Work access"})`} items={preview.resources.models} />
      <ResourceList title={`Plugins (${preview.resources.pluginMode === "assigned" ? "assigned to this project" : "member's Work access"})`} items={preview.resources.plugins} />
      <ResourceList title={`Skills (${preview.resources.skillMode === "assigned" ? "assigned to this project" : "member's Work access"})`} items={preview.resources.skills} />
    </div>}
  </div>;
}

export function ProjectMembers({ projectId, admin, onDirtyChange, onBusyChange, onSaved }: { projectId: string; admin: boolean; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onSaved: () => void }) {
  const [directory, setDirectory] = useState<Directory>({ members: [], teams: [] });
  const [baseline, setBaseline] = useState<ProjectMemberships | null>(null);
  const [grants, setGrants] = useState<ProjectGrant[]>([]), [blocks, setBlocks] = useState<string[]>([]);
  const [previewMember, setPreviewMember] = useState(""), [preview, setPreview] = useState<ProjectEffectiveAccess | null>(null);
  const [selected, setSelected] = useState(""), [block, setBlock] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const directManagers = grants.filter(grant => grant.kind === "member" && grant.role === "manager" && !blocks.includes(grant.subjectId) && !grant.deniedActions.includes("read"));
  // Organization admins always manage shared projects, so only delegated managers must keep one.
  const requiredManager = !admin && directManagers.length === 1 ? directManagers[0]!.subjectId : null;
  const blockOptions = directory.members.map(member => ({
    value: member.id,
    label: member.name,
    description: `${member.id === requiredManager ? "Required project manager · " : blocks.includes(member.id) ? "Already blocked · " : ""}${member.email}`,
    disabled: blocks.includes(member.id) || member.id === requiredManager,
  }));
  const dirty = !!baseline && (JSON.stringify(grants) !== JSON.stringify(baseline.grants) || JSON.stringify(blocks) !== JSON.stringify(baseline.blocks.map(b => b.memberId)));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    setPreview(null); if (!previewMember) return;
    let active = true;
    void cloudApi<ProjectEffectiveAccess>(`/projects/${projectId}/members/${encodeURIComponent(previewMember)}/effective`).then(value => { if (active) setPreview(value); }).catch(f => { if (active) setError(cloudError(f)); });
    return () => { active = false; };
  }, [projectId, previewMember, baseline?.revision]);
  const load = useCallback(async () => {
    setError(""); setBusy(true);
    try {
      const [members, choices] = await Promise.all([cloudApi<ProjectMemberships>(`/projects/${projectId}/members`), cloudApi<Directory>(`/projects/directory?projectId=${projectId}`)]);
      setBaseline(members); setGrants(members.grants); setBlocks(members.blocks.map(b => b.memberId)); setDirectory(choices);
    } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  return <section className="space-y-4" aria-label="Project access">
    <div><h3 className="text-sm font-semibold">Members and teams</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Everyone with read access shares this project’s chats, files, and memory. Explicit restrictions and blocks take precedence.</p></div>
    <div className="flex items-center gap-2"><Choice directory={directory} value={selected} onChange={setSelected} disabled={busy} assigned={grants.map(key)} /><Button variant="outline" disabled={!selected || busy} onClick={() => { const next = assignment(selected); if (!grants.some(g => key(g) === selected)) setGrants([...grants, { ...next, id: crypto.randomUUID(), role: "contributor", deniedActions: [] }]); setSelected(""); }}>Add</Button></div>
    <ul className="divide-y divide-border">{grants.map(g => <li key={g.id} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 basis-40 text-sm"><span className="block truncate">{label(directory, g)}</span><span className="block truncate text-xs text-muted-foreground">{g.kind === "member" ? directory.members.find(member => member.id === g.subjectId)?.email : "Team access"}</span></span>
        <SearchSelect label={`Role for ${label(directory, g)}${g.kind === "member" ? ` (${directory.members.find(member => member.id === g.subjectId)?.email ?? "former member"})` : " (team)"}`} value={g.role} disabled={busy} options={g.kind === "member" && g.subjectId === requiredManager ? roleOptions.map(option => option.value === "manager" ? option : { ...option, disabled: true, description: "Assign another direct manager first" }) : roleOptions} onChange={role => setGrants(current => current.map(item => item.id === g.id ? { ...item, role: role as ProjectGrant["role"] } : item))} className="w-40 shrink-0" searchPlaceholder="Find a role…" />
        <Button size="sm" variant="ghost" title={g.kind === "member" && g.subjectId === requiredManager ? "Assign another direct manager before removing this one" : undefined} disabled={busy || (g.kind === "member" && g.subjectId === requiredManager) || (!admin && !!baseline?.grants.find(old => key(old) === key(g))?.deniedActions.length)} onClick={() => setGrants(current => current.filter(item => item.id !== g.id))}>Remove</Button>
      </div>
      {g.kind === "member" && g.subjectId === requiredManager && <p className="text-xs text-muted-foreground">Assign another direct manager before removing or changing this manager.</p>}
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Restrictions{g.deniedActions.length ? ` (${g.deniedActions.length})` : ""}</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{PROJECT_ACTIONS.filter(action => action !== "read").map(action => <label key={action} className="flex items-start gap-2"><input type="checkbox" checked={g.deniedActions.includes(action)} disabled={busy || (!admin && !!baseline?.grants.find(old => key(old) === key(g))?.deniedActions.includes(action))} onChange={e => setGrants(current => current.map(item => item.id === g.id ? { ...item, deniedActions: e.target.checked ? [...item.deniedActions, action] : item.deniedActions.filter(a => a !== action) } : item))} /><span>Block {actionLabels[action].toLowerCase()}</span></label>)}</div></details>
    </li>)}</ul>
    {admin && <details className="space-y-3 text-sm">
      <summary className="cursor-pointer font-medium">Blocked members ({blocks.length})</summary>
      <p className="text-xs text-muted-foreground">A block prevents access even when another team grants it. Organization owners and admins keep full access to shared projects.</p>
      <div className="flex gap-2">
        <SearchSelect label="Member to block" placeholder="Choose a member" searchPlaceholder="Search name or email…" value={block} onChange={setBlock} disabled={busy} className="flex-1" options={blockOptions} />
        <Button variant="outline" disabled={!block || busy || block === requiredManager} onClick={() => { setBlocks(current => [...new Set([...current, block])]); setBlock(""); }}>Block</Button>
      </div>
      {blocks.map(id => <div key={id} className="flex items-center justify-between gap-2"><span>{directory.members.find(m => m.id === id)?.name ?? "Former member"}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => setBlocks(current => current.filter(item => item !== id))}>Unblock</Button></div>)}
    </details>}
    <details className="space-y-3 text-sm"><summary className="cursor-pointer font-medium">Effective access</summary><p className="text-xs text-muted-foreground">Preview saved grants, team inheritance, blocks, and Work access. Unsaved edits are not included.</p><SearchSelect label="Preview member access" placeholder="Choose a member" searchPlaceholder="Search name or email…" value={previewMember} onChange={setPreviewMember} options={directory.members.map(m => ({ value: m.id, label: m.name, description: m.email }))} />{preview && <EffectiveAccess preview={preview} directory={directory} />}</details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button disabled={busy || !dirty} onClick={async () => { if (!baseline) return; setBusy(true); setError(""); try { await cloudApi(`/projects/${projectId}/members`, cloudMutation({ expectedRevision: baseline.revision, grants: grants.map(({ id: _id, ...g }) => g), blocks }, "PUT")); await load(); onSaved(); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>Save access</Button><Button variant="ghost" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard unsaved access changes?")) void load(); }}>Reload</Button></div>
  </section>;
}
