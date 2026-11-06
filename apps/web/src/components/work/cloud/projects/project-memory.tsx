"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudProjectDetail, ProjectMemory } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { projectField } from "./project-ui";

export function ProjectMemoryPanel({ project, onDirtyChange, onBusyChange }: { project: CloudProjectDetail; onDirtyChange?: (value: boolean) => void; onBusyChange?: (value: boolean) => void }) {
  const [notes, setNotes] = useState<ProjectMemory[]>([]), [selected, setSelected] = useState<ProjectMemory | null>(null);
  const [editing, setEditing] = useState(false), [topic, setTopic] = useState(""), [content, setContent] = useState(""), [sensitive, setSensitive] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [limit, setLimit] = useState(20);
  const requestId = useRef<string | null>(null);
  const canWrite = project.access.actions.includes("memory.write"), canDelete = project.access.actions.includes("memory.delete");
  const dirty = editing && (topic !== (selected?.topic ?? "") || content !== (selected?.content ?? "") || sensitive !== (selected?.sensitive ?? false));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const load = useCallback(async () => {
    try { setNotes((await cloudApi<{ notes: ProjectMemory[] }>(`/projects/${project.id}/memory`)).notes); setError(""); }
    catch (failure) { setError(cloudError(failure)); }
  }, [project.id]);
  useEffect(() => { if (project.policy.memoryEnabled) void load(); }, [load, project.policy.memoryEnabled]);
  const edit = (note: ProjectMemory | null) => {
    if (dirty && !window.confirm("Discard this unsaved memory?")) return;
    setSelected(note); setTopic(note?.topic ?? ""); setContent(note?.content ?? ""); setSensitive(note?.sensitive ?? false); setEditing(true); requestId.current = crypto.randomUUID();
  };
  return <section className="space-y-4" aria-label="Project memory">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Project memory</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Shared notes help future conversations in this project. Personal memory and other projects are excluded.</p></div>{canWrite && <Button size="sm" variant="outline" onClick={() => edit(null)}>Add memory</Button>}</div>
    {!project.policy.memoryEnabled ? <p className="text-sm text-muted-foreground">Memory is disabled for this project.</p> : <>
      <ul className="divide-y divide-border">{notes.slice(0, limit).map(note => <li key={note.id} className="space-y-2 py-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{note.topic}</span><div className="flex shrink-0 gap-1">{canWrite && <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(note)}>Edit</Button>}{canDelete && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (!window.confirm("Delete this shared project memory?")) return; setBusy(true); try { await cloudApi(`/projects/${project.id}/memory/${note.id}?expectedRevision=${note.revision}`, { method: "DELETE" }); if (selected?.id === note.id) setEditing(false); await load(); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>Delete</Button>}</div></div><p className="whitespace-pre-wrap text-sm text-muted-foreground">{note.content}</p>{note.sensitive && <p className="text-xs text-muted-foreground">Sensitive · excluded from automatic recall</p>}</li>)}</ul>
      {notes.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit(value => value + 20)}>Show more memories</Button>}
      {!notes.length && !editing && <p className="text-sm text-muted-foreground">No saved project memories yet.</p>}
      {editing && <form className="space-y-3 rounded-md border border-border p-4" onSubmit={async e => { e.preventDefault(); if (!canWrite || busy) return; setBusy(true); setError(""); try { await cloudApi(`/projects/${project.id}/memory${selected ? `/${selected.id}` : ""}`, cloudMutation({ topic, content, sensitive, ...(selected ? { expectedRevision: selected.revision } : { requestId: requestId.current ??= crypto.randomUUID() }) }, selected ? "PATCH" : "POST")); setEditing(false); await load(); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>
        <label className="grid gap-1 text-xs">Topic<input className={projectField} value={topic} onChange={e => setTopic(e.target.value)} maxLength={160} required disabled={!canWrite || busy} /></label>
        <label className="grid gap-1 text-xs">Memory<textarea className={`${projectField} min-h-28`} value={content} onChange={e => setContent(e.target.value)} maxLength={12000} required disabled={!canWrite || busy} /></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={sensitive} onChange={e => setSensitive(e.target.checked)} disabled={!canWrite || busy} />Sensitive: keep out of automatic recall</label>
        <div className="flex gap-2"><Button size="sm" disabled={!canWrite || busy || !dirty || !topic.trim() || !content.trim()}>Save memory</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
      </form>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
