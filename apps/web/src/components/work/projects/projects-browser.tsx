"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import type { CloudProject, CloudProjectDetail, ProjectManagementPage } from "@lori-enterprise/contracts";
import Link from "next/link";
import { ArrowLeftIcon, ArrowUpRightIcon, FolderIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { ProjectGovernance } from "@/components/work/cloud/projects/project-governance";
import { ProjectSettings } from "@/components/work/cloud/projects/project-settings";
import { projectField } from "@/components/work/cloud/projects/project-ui";
import { ClientApiError } from "@/lib/client-api";
export function ProjectsBrowser({ admin, projectId, management = false }: { admin: boolean; projectId?: string; management?: boolean }) {
  const [projects, setProjects] = useState<CloudProject[]>([]), [detail, setDetail] = useState<CloudProjectDetail | null>(null);
  const [confirmedAdmin, setConfirmedAdmin] = useState(admin);
  const orgAdmin = management ? confirmedAdmin : admin;
  const [verified, setVerified] = useState(true);
  const [query, setQuery] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const load = useCallback(async (background = false) => {
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    if (!background) { setLoading(true); setError(""); }
    try {
      const items: CloudProject[] = []; let cursor: string | null = null;
      if (management && projectId) {
        const page = await cloudApi<ProjectManagementPage>(`/projects/management?projectId=${encodeURIComponent(projectId)}&limit=1`, { signal: controller.signal });
        if (!controller.signal.aborted) setConfirmedAdmin(page.canAdminister);
        items.push(...page.projects);
        // A manager of another project may still hold ordinary read access here.
        if (!items.length && !page.canAdminister) {
          try { items.push(await cloudApi<CloudProjectDetail>(`/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal })); }
          catch (failure) { if (!(failure instanceof ClientApiError && [403,404].includes(failure.status))) throw failure; }
        }
      } else do { const page: { projects: CloudProject[]; nextCursor: string | null } = await cloudApi(`/projects?admin=${admin}${cursor ? `&cursor=${cursor}` : ""}`, { signal: controller.signal }); items.push(...page.projects); cursor = page.nextCursor; } while (cursor && items.length < 2500);
      if (cursor) throw new Error("The project list is incomplete. Try again or contact your administrator.");
      if (!controller.signal.aborted) { setProjects(management ? items : admin ? items : items.filter(item => item.access.actions.includes("read"))); setVerified(true); }
    } catch (f) { if (!controller.signal.aborted) { setError(cloudError(f)); setVerified(false); if (f instanceof ClientApiError && [401,403,404].includes(f.status)) { setProjects([]); setDetail(null); } } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [admin, management, projectId]);
  useEffect(() => { void load(); const refresh = () => { void load(true); }; const interval = setInterval(refresh, 15000); window.addEventListener("focus", refresh); return () => { clearInterval(interval); window.removeEventListener("focus", refresh); listRequest.current?.abort(); }; }, [load]);
  const project = projects.find(item => item.id === projectId) ?? null;
  useEffect(() => {
    if (orgAdmin || !project) { setDetail(null); return; }
    const controller = new AbortController();
    void cloudApi<CloudProjectDetail>(`/projects/${project.id}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(f => { if (!controller.signal.aborted) { setError(cloudError(f)); setDetail(null); } });
    return () => controller.abort();
  }, [orgAdmin, project?.id, project?.revision]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigation = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || link.getAttribute("target") === "_blank") return;
      if (busy || !window.confirm("Discard unsaved project settings and leave this page?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", guard); document.addEventListener("click", navigation, true);
    return () => { window.removeEventListener("beforeunload", guard); document.removeEventListener("click", navigation, true); };
  }, [dirty, busy]);
  return <div className="space-y-5">
    {error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" onClick={() => void load()}>Reload</Button></div>}
    <div inert={!verified || undefined} aria-hidden={!verified || undefined} style={!verified ? { visibility: "hidden" } : undefined}>
      {!projectId && <section aria-label="Project overview" className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative w-full sm:max-w-sm"><SearchIcon aria-hidden className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><input aria-label="Find a project" placeholder="Find a project" className={`${projectField} pl-9`} value={query} onChange={e => setQuery(e.target.value)} /></div>{!loading && <span className="text-xs text-muted-foreground">{projects.length} {projects.length === 1 ? "project" : "projects"}</span>}</div>
        {loading && !projects.length && <p role="status" className="py-8 text-sm text-muted-foreground">Loading projects…</p>}
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{projects.filter(p => `${p.name} ${p.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(p => <li key={p.id} className="min-w-0"><Link href={`/work/projects/${encodeURIComponent(p.id)}`} className="group flex h-full min-h-44 flex-col rounded-xl border border-border bg-background p-5 outline-none transition-colors hover:border-border-strong hover:bg-secondary/30 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
          <div className="mb-4 flex items-center justify-between gap-3"><FolderIcon aria-hidden className="size-5 text-muted-foreground" /><span className="rounded border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">{p.status}</span></div>
          <h2 className="break-words text-base font-semibold leading-6">{p.name}</h2><p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{p.description || "Shared conversations, files, and project context."}</p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-5 text-xs text-muted-foreground"><span>{orgAdmin ? "Organization admin" : p.access.role === "manager" ? "Project manager" : p.access.role === "contributor" ? "Contributor" : "View access"}</span><span className="inline-flex items-center gap-1">View project<ArrowUpRightIcon aria-hidden className="size-3.5" /></span></div>
        </Link></li>)}</ul>
        {!loading && !projects.length && <div className="py-12 text-center"><FolderIcon aria-hidden className="mx-auto mb-3 size-6 text-muted-foreground" /><h2 className="text-sm font-medium">No projects available</h2><p className="mt-2 text-sm text-muted-foreground">{orgAdmin ? "Create a project in Work to organize shared conversations and files." : "Projects appear here when your administrator or project manager grants you access."}</p></div>}
        {!loading && projects.length > 0 && !projects.some(p => `${p.name} ${p.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p role="status" className="py-8 text-center text-sm text-muted-foreground">No projects match your search.</p>}
      </section>}
      {projectId && <><Link href="/work/projects" className="mb-5 inline-flex items-center gap-2 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeftIcon aria-hidden className="size-4" />All projects</Link>
      <section aria-label="Project management" className="min-w-0">
        {project ? <><div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4"><div><h1 className="break-words text-2xl font-semibold tracking-tight">{project.name}</h1><p className="mt-1 text-xs text-muted-foreground">{orgAdmin ? "Organization administration" : project.access.role === "manager" ? "Project manager" : project.access.role === "contributor" ? "Contributor access" : "Read-only access"} · {project.status}</p></div>{project.access.actions.includes("read") && <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => window.location.assign(`/work/cloud?project=${project.id}`)}>Open in Work</Button>}</div>
          {orgAdmin ? <ProjectGovernance key={project.id} project={project} onChanged={() => void load()} onDirtyChange={setDirty} onBusyChange={setBusy} /> : detail ? <ProjectSettings key={project.id} project={detail} admin={false} onChanged={() => void load()} onDirtyChange={setDirty} onBusyChange={setBusy} /> : <p role="status" className="text-sm text-muted-foreground">Checking project access…</p>}
        </> : <p role="status" className="py-12 text-center text-sm text-muted-foreground">{loading ? "Loading project…" : "This project is unavailable or you do not have access."}</p>}
      </section></>}
    </div>
  </div>;
}
