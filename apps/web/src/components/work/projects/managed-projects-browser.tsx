"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { FolderIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { ProjectManagementFilters, ProjectManagementPage } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { getPersonalCapabilities } from "@/lib/personal-projects-api";
import { ClientApiError } from "@/lib/client-api";
import { projectField } from "../cloud/projects/project-ui";
import { CreationAccess } from "./creation/creation-access";
import { ProjectsTabs, panelId, tabId } from "./projects-tabs";
import { CreateManagedProject } from "./create-managed-project";

interface Directory { members: { id: string; name: string; email: string }[]; teams: { id: string; name: string }[] }
export type ManagementTab = "projects" | "creation";
export function ManagedProjectsBrowser({ initialFilters = {}, initialTab = "projects" }: { initialFilters?: ProjectManagementFilters; initialTab?: ManagementTab }) {
  const [personalAdministrator, setPersonalAdministrator] = useState(false);
  const [page, setPage] = useState<ProjectManagementPage | null>(null), [verified, setVerified] = useState(false);
  const [query, setQuery] = useState(initialFilters.query ?? ""), [status, setStatus] = useState(initialFilters.status ?? "");
  const [memberId, setMemberId] = useState(initialFilters.memberId ?? ""), [teamId, setTeamId] = useState(initialFilters.teamId ?? "");
  const [directory, setDirectory] = useState<Directory | null>(null), [directoryError, setDirectoryError] = useState("");
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [createOpen, setCreateOpen] = useState(false);
  const [creationDirty, setCreationDirty] = useState(false), [creationBusy, setCreationBusy] = useState(false);
  const [tab, setTab] = useState<ManagementTab>(initialTab), [creationVisited, setCreationVisited] = useState(initialTab === "creation");
  const tabsBase = useId();
  const [history, setHistory] = useState<(string | null)[]>([]), [totals, setTotals] = useState<{ total: number; active: number } | null>(null);
  const request = useRef<AbortController | null>(null), currentCursor = useRef<string | null>(null);
  const load = useCallback(async (cursor: string | null = null, background = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    if (!background) { setLoading(true); setError(""); }
    // Personal administration must remain available when team workspaces are unavailable.
    void getPersonalCapabilities(controller.signal).then(caps => {
      if (!controller.signal.aborted) setPersonalAdministrator(caps.canAdminister === true);
    }).catch(() => { if (!controller.signal.aborted) setPersonalAdministrator(false); });
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (query.trim()) params.set("query", query.trim()); if (status) params.set("status", status);
      if (memberId) params.set("memberId", memberId); if (teamId) params.set("teamId", teamId);
      let next = cursor, result: ProjectManagementPage;
      const seen = new Set<string>();
      do {
        if (next) { if (seen.has(next)) throw new Error("Project pagination did not advance."); seen.add(next); params.set("cursor", next); } else params.delete("cursor");
        result = await cloudApi(`/projects/management?${params}`, { signal: controller.signal });
        if (!Array.isArray(result.projects) || typeof result.canAdminister !== "boolean" || typeof result.canCreate !== "boolean") throw new Error("The project inventory could not be read. Reload it to continue.");
        if (!controller.signal.aborted && result.total !== undefined) setTotals({ total: result.total, active: result.activeCount ?? 0 });
        next = result.nextCursor;
      } while (!result.projects.length && next && !controller.signal.aborted);
      if (!controller.signal.aborted) { currentCursor.current = cursor; setPage(result); setVerified(true); setError(""); }
    } catch (failure) {
      if (!controller.signal.aborted) { setVerified(false); setError(cloudError(failure)); if (failure instanceof ClientApiError && [401,403,404].includes(failure.status)) setPage(null); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [query, status, memberId, teamId]);
  useEffect(() => { currentCursor.current = null; setHistory([]); setTotals(null); const timer = window.setTimeout(() => void load(), query ? 250 : 0); return () => { clearTimeout(timer); request.current?.abort(); }; }, [load, query]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void load(currentCursor.current, true); };
    const interval = window.setInterval(refresh, 15000); window.addEventListener("focus", refresh);
    return () => { clearInterval(interval); window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => {
    if (!creationDirty && !creationBusy) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && link.getAttribute("target") !== "_blank" && (creationBusy || !window.confirm("Discard unsaved creation permissions?"))) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [creationDirty, creationBusy]);
  const loadDirectory = async () => {
    if (!page?.canAdminister) return;
    setDirectoryError("");
    try { setDirectory(await cloudApi<Directory>("/projects/directory")); } catch (failure) { setDirectoryError(cloudError(failure)); }
  };
  const administrator = personalAdministrator || page?.canAdminister === true, activeTab = administrator ? tab : "projects";
  const chooseTab = (next: ManagementTab) => {
    setTab(next); if (next === "creation") setCreationVisited(true);
    const url = new URL(window.location.href);
    if (next === "creation") url.searchParams.set("tab", "creation"); else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
  };
  return <div className="space-y-5">
    {administrator && <ProjectsTabs base={tabsBase} label="Project management" value={activeTab} onChange={chooseTab} tabs={[{ id: "projects", label: "All projects" }, { id: "creation", label: "Creation access", unsaved: creationDirty }]} />}
    <div className="space-y-5" {...(administrator ? { role: "tabpanel", id: panelId(tabsBase, "projects"), "aria-labelledby": tabId(tabsBase, "projects") } : {})} hidden={activeTab !== "projects"}>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm leading-6 text-muted-foreground">{page?.canAdminister ? "Manage project access, permissions, connections, and lifecycle across your organization." : "Manage the projects and actions explicitly delegated to you."}</p>{page?.canCreate && <Button disabled={!verified || creationBusy || creationDirty} onClick={() => setCreateOpen(true)}><PlusIcon aria-hidden className="size-4" />Create project</Button>}</div>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive"><p>{error}</p><Button size="sm" variant="outline" onClick={() => void load(currentCursor.current)}>Reload</Button></div>}
    <section aria-label="Project administration" aria-busy={loading} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><div className="relative min-w-0 flex-1 sm:max-w-sm"><SearchIcon aria-hidden className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><input aria-label="Find a managed project" placeholder="Find a project" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} className={`${projectField} pl-9`} /></div><label className="flex items-center gap-2 text-xs text-muted-foreground">Status<select className={`${projectField} w-auto`} value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="">All</option><option value="active">Active</option><option value="archived">Archived</option>{page?.canAdminister && <option value="deleted">Deleted</option>}</select></label>{!query.trim() && totals && <span className="text-xs text-muted-foreground">{totals.total} projects · {totals.active} active</span>}</div>
      {page?.canAdminister && <details onToggle={event => { if (event.currentTarget.open && !directory) void loadDirectory(); }}><summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Filter by assignments</summary><div className="mt-3 flex max-w-2xl flex-wrap items-end gap-3"><SearchSelect label="Assigned member" placeholder="All members" searchPlaceholder="Find a member…" value={memberId} onChange={setMemberId} options={directory?.members.map(member => ({ value: member.id, label: member.name, description: member.email })) ?? []} className="min-w-48 flex-1" /><SearchSelect label="Assigned team" placeholder="All teams" searchPlaceholder="Find a team…" value={teamId} onChange={setTeamId} options={directory?.teams.map(team => ({ value: team.id, label: team.name })) ?? []} className="min-w-48 flex-1" /><Button size="sm" variant="ghost" disabled={!memberId && !teamId} onClick={() => { setMemberId(""); setTeamId(""); }}>Clear</Button>{directoryError && <div className="w-full text-xs"><p role="alert" className="text-destructive">{directoryError}</p><button type="button" className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void loadDirectory()}>Try again</button></div>}</div></details>}
      {(memberId || teamId) && <p className="text-xs text-muted-foreground">Showing projects assigned through the selected member or team. <button type="button" className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setMemberId(""); setTeamId(""); }}>Clear assignment filters</button></p>}
      {loading && !page && <p role="status" className="py-8 text-sm text-muted-foreground">Loading project administration…</p>}
      <div inert={!verified || undefined} aria-hidden={!verified || undefined} style={!verified ? { visibility: "hidden" } : undefined}>
        <ul className="divide-y divide-border border-y border-border">{page?.projects.map(project => <li key={project.id} className="flex min-w-0 items-start gap-3 py-5"><FolderIcon aria-hidden className="mt-1 hidden size-4 shrink-0 text-muted-foreground sm:block" /><div className="min-w-0 flex-1"><Link href={`/work/projects/${project.id}`} className="break-words rounded text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{project.name}</Link>{project.description && <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{project.description}</p>}{project.assignments ? <div className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"><p>{project.assignments.teamCount} teams · {project.assignments.directMemberCount} direct members{project.assignments.blockedMemberCount > 0 ? ` · ${project.assignments.blockedMemberCount} blocked` : ""}</p>{project.assignments.teams.length > 0 && <p className="break-words">{project.assignments.teams.map(team => team.name).join(", ")}{project.assignments.teamCount > project.assignments.teams.length ? "…" : ""}</p>}{project.assignments.members.length > 0 && <p className="break-words">{project.assignments.members.map(member => `${member.name}${member.blocked ? " (blocked)" : ""}`).join(", ")}{project.assignments.directMemberCount > project.assignments.members.length ? "…" : ""}</p>}</div> : <p className="mt-2 text-xs text-muted-foreground">Project manager · Assignment management is not delegated</p>}</div><div className="flex shrink-0 flex-col items-end gap-3"><span className="rounded border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">{project.status}</span><Link href={`/work/projects/${project.id}`} className="rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">Manage</Link></div></li>)}</ul>
        {!loading && page && !page.projects.length && <p role="status" className="py-8 text-center text-sm text-muted-foreground">{query.trim() || status || memberId || teamId ? "No projects match these filters." : page.canAdminister ? "No projects yet. Create one to configure its access and permissions." : "No projects are currently delegated to you."}</p>}
        {(history.length > 0 || page?.nextCursor) && <div className="mt-4 flex justify-between"><Button size="sm" variant="outline" disabled={loading || !history.length} onClick={() => { const previous = history.at(-1) ?? null; setHistory(value => value.slice(0, -1)); void load(previous); }}>Previous</Button><Button size="sm" variant="outline" disabled={loading || !page?.nextCursor} onClick={() => { setHistory(value => [...value, currentCursor.current]); void load(page?.nextCursor ?? null); }}>Next</Button></div>}
      </div>
    </section>
    </div>
    {administrator && creationVisited && <div role="tabpanel" id={panelId(tabsBase, "creation")} aria-labelledby={tabId(tabsBase, "creation")} hidden={activeTab !== "creation"}><CreationAccess onSaved={() => void load(currentCursor.current)} onDirtyChange={setCreationDirty} onBusyChange={setCreationBusy} /></div>}
    <CreateManagedProject open={createOpen} allowed={verified && page?.canCreate === true} onClose={() => setCreateOpen(false)} onCreated={project => { setCreateOpen(false); window.location.assign(`/work/projects/${project.id}`); }} />
  </div>;
}
