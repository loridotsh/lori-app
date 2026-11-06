"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudConversation, CloudConversationPage, CloudProject, CloudProjectDetail, PersonalProject, PersonalProjectCapabilities, ProjectCapabilities, Viewer } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cloudApi, cloudError, cloudMutation, validateCloudConversationPage, validateCloudCapabilities, validateCloudDetail } from "@/lib/cloud-work-api";
import { CloudWorkspace, type PersonalWorkspaceBinding, type WorkspaceBootstrap } from "../cloud-workspace";
import { creationOptions } from "./project-creation";
import { PersonalProjectPanel } from "../personal/personal-project-panel";
import { createPersonalProject, getPersonalCapabilities, listPersonalProjects } from "@/lib/personal-projects-api";
import { ProjectMemoryPanel } from "./project-memory";
import { ClientApiError } from "@/lib/client-api";
import { ProjectNavigation, type CreationControl, type PersonalNavigationProps, type ProjectNavigationContext, type NavigationPresentation } from "./project-navigation";
import { canManageProject } from "@/lib/manage-destination";
import { isAdministrator } from "@/lib/authority";
import { projectField } from "./project-ui";

async function listing(admin = false) {
  const all: CloudProject[] = []; let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ admin: String(admin) }); if (cursor) query.set("cursor", cursor);
    const page: { projects: CloudProject[]; nextCursor: string | null } = await cloudApi(`/projects?${query}`);
    all.push(...page.projects); cursor = page.nextCursor;
  } while (cursor && all.length < 2500);
  if (cursor) throw new Error("Project listing is incomplete. Contact your administrator to narrow your project access.");
  return all;
}
export function ProjectWorkHome({ viewer }: { viewer: Viewer }) {
  const admin = isAdministrator(viewer);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities | null>(null);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [project, setProject] = useState<CloudProjectDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [initialConversationId, setInitialConversationId] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [locked, setLocked] = useState("");
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<"create" | "create-personal" | null>(null);
  const [personalCapabilities, setPersonalCapabilities] = useState<PersonalProjectCapabilities | null>(null);
  const [personalProjects, setPersonalProjects] = useState<PersonalProject[]>([]);
  const [panelProjectId, setPanelProjectId] = useState<string | null>(null);
  const [newChatProjectId, setNewChatProjectId] = useState<string | null>(null);
  const [personalError, setPersonalError] = useState("");
  const [personalRefresh, setPersonalRefresh] = useState(0);
  const personalCreationId = useRef<string | null>(null);
  const personalGeneration = useRef(0);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [navigationPages, setNavigationPages] = useState<Record<string, CloudConversationPage>>({});
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarScroll = useRef(0);
  const presentation = useRef<NavigationPresentation>(new Map());
  const mobilePresentation = useRef<NavigationPresentation>(new Map());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const generation = useRef(0), creationId = useRef<string | null>(null);
  const guard = useRef<() => boolean>(() => true);
  const listingGeneration = useRef(0);
  const onProjectAccessLost = useCallback(() => { setProject(null); setLocked("This project is unavailable or you do not have access."); }, []);
  const refreshPersonal = useCallback(async () => {
    const request = ++personalGeneration.current;
    try {
      const caps = await getPersonalCapabilities();
      const next = caps.available ? (await Promise.all([listPersonalProjects("active"), listPersonalProjects("archived"), listPersonalProjects("deleted")])).flat() : [];
      if (request === personalGeneration.current) { setPersonalCapabilities(caps); setPersonalProjects(next); setPersonalError(""); }
    } catch (failure) {
      if (request !== personalGeneration.current) return;
      setPersonalError(cloudError(failure));
      // Preserve mounted editors during a temporary outage; confirmed access loss withdraws them.
      if (failure instanceof ClientApiError && [401, 403, 404].includes(failure.status)) {
        setPersonalCapabilities(null); setPersonalProjects([]);
      }
    }
  }, []);
  const refresh = useCallback(async () => {
    void refreshPersonal();
    const request = ++listingGeneration.current;
    try {
      const caps = await cloudApi<ProjectCapabilities>("/projects/capabilities");
      const next = caps.available ? await listing() : [];
      if (request === listingGeneration.current) { setCapabilities(caps); setProjects(next); }
    } catch { if (request === listingGeneration.current) setCapabilities(null); }
  }, [refreshPersonal]);
  useEffect(() => {
    const update = () => { void refresh(); };
    const timer = window.setInterval(update, 15000);
    window.addEventListener("focus", update); window.addEventListener("online", update);
    return () => { ++listingGeneration.current; ++personalGeneration.current; clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener("online", update); };
  }, [refresh]);
  const open = useCallback(async (id: string | null, conversationId?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = id ? await cloudApi<CloudProjectDetail>(`/projects/${encodeURIComponent(id)}`) : null;
      const scopeOptions = id ? { headers: { "x-lori-project-id": id } } : undefined;
      const nextCapabilities = validateCloudCapabilities(await cloudApi("/capabilities", scopeOptions));
      if (!nextCapabilities.enabled) throw new Error("Cloud Work is unavailable for this account.");
      // The server scopes models to the project's resource assignment; it is the only source.
      const nextDetail = conversationId ? validateCloudDetail(await cloudApi(`/conversations/${encodeURIComponent(conversationId)}`, scopeOptions)) : null;
      if (nextDetail && (nextDetail.conversation.id !== conversationId || (nextDetail.conversation.projectId ?? null) !== id)) throw new Error("The conversation does not belong to this workspace.");
      const nextFiles = nextDetail?.files ?? (id ? (await cloudApi<{ files: WorkspaceBootstrap["files"] }>(`/conversations/${encodeURIComponent(id)}/files`, scopeOptions)).files : []);
      const scopes = [...new Set(["private", ...expandedRef.current, ...(id ? [id] : [])])];
      const pages = await Promise.all(scopes.map(async scope => {
        try {
          const target = scope === "private" ? "/conversations" : `/projects/${encodeURIComponent(scope)}/conversations`;
          const count = Math.max(presentation.current.get(scope)?.count ?? 0, mobilePresentation.current.get(scope)?.count ?? 0, scope === "private" ? 30 : 5);
          const page = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`${target}?limit=${Math.min(50, count)}`));
          const seen = new Set<string>();
          while (page.nextCursor && page.conversations.length < count) {
            if (seen.has(page.nextCursor)) throw new Error("Conversation pagination did not advance.");
            seen.add(page.nextCursor);
            const next = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`${target}?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`));
            page.conversations.push(...next.conversations); page.nextCursor = next.nextCursor;
          }
          return [scope, page] as const;
        }
        catch (failure) { if (scope === (id ?? "private")) throw failure; return null; }
      }));
      if (current !== generation.current) return;
      setNavigationPages(Object.fromEntries(pages.filter(value => value !== null)));
      setBootstrap({ capabilities: nextCapabilities, detail: nextDetail, files: nextFiles });
      setInitialConversationId(conversationId);
      if (id) setExpanded(previous => new Set([...previous, id]));
      setSelected(id); setProject(next); setLocked("");
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("project", id); else url.searchParams.delete("project");
      if (conversationId) url.searchParams.set("conversation", conversationId); else url.searchParams.delete("conversation");
      window.history.replaceState(null, "", url);
      return true;
    } catch (failure) { if (current === generation.current) setError(cloudError(failure)); }
    finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(); const id = new URLSearchParams(window.location.search).get("project"); if (id) void open(id, new URLSearchParams(window.location.search).get("conversation") ?? undefined); else setInitialConversationId(new URLSearchParams(window.location.search).get("conversation") ?? undefined);
    return () => { generation.current++; };
  }, [refresh, open]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    const verify = async () => {
      const current = generation.current;
      try {
        const next = await cloudApi<CloudProjectDetail>(`/projects/${encodeURIComponent(selected)}`);
        if (disposed || current !== generation.current) return;
        setLocked(""); setProject(old => old && JSON.stringify(old) === JSON.stringify(next) ? old : next);
      } catch (failure) {
        if (disposed || current !== generation.current) return;
        if (failure instanceof ClientApiError && [401, 403, 404].includes(failure.status)) setProject(null);
        setLocked(cloudError(failure));
      }
    };
    const offline = () => { setLocked("Connect to Enterprise to open this project."); };
    const tick = window.setInterval(() => void verify(), 15000);
    window.addEventListener("focus", verify); window.addEventListener("online", verify); window.addEventListener("offline", offline);
    return () => { disposed = true; clearInterval(tick); window.removeEventListener("focus", verify); window.removeEventListener("online", verify); window.removeEventListener("offline", offline); };
  }, [selected]);
  const choose = (id: string | null, conversationId?: string) => { if (guard.current()) { void open(id, conversationId); setModal(null); } };
  const navigation = (canLeave: () => boolean, context: ProjectNavigationContext) => {
    guard.current = canLeave;
    const teamAvailable = !!capabilities?.available;
    const personalAvailable = !!personalCapabilities?.available;
    if (!teamAvailable && !personalAvailable) return null;
    const personalNavigation: PersonalNavigationProps | undefined = personalAvailable ? {
      projects: personalProjects, activeProjectId: context.personalProjectId ?? null, panelProjectId, refreshKey: `${personalRefresh}:${context.conversationId ?? ""}`,
      onOpen: (_projectId, conversationId) => { if (selected) choose(null, conversationId); else context.openConversation(conversationId); },
      onNew: projectId => {
        if (selected) {
          if (canLeave()) void open(null).then(opened => { if (opened) setNewChatProjectId(projectId); });
        } else if (context.newConversation() !== false) setNewChatProjectId(projectId);
      },
      onSettings: projectId => {
        if (!canLeave()) return;
        const show = () => { setPanelProjectId(projectId); if (context.mobile) document.querySelector<HTMLDialogElement>("dialog[open]")?.close(); };
        if (selected) { void open(null).then(opened => { if (opened) show(); }); } else show();
      },
    } : undefined;
    const creation: CreationControl = { options: creationOptions(capabilities, personalCapabilities), onChoose: kind => {
      if (!canLeave()) return;
      setName(""); setError("");
      if (kind === "personal") { personalCreationId.current = crypto.randomUUID(); setModal("create-personal"); }
      else { creationId.current = crypto.randomUUID(); setModal("create"); }
    } };
    const visibleProjects = !teamAvailable ? [] : project ? projects.some(item => item.id === project.id) ? projects.map(item => item.id === project.id ? project : item) : [...projects, project] : projects;
    return <><ProjectNavigation personal={personalNavigation} creation={creation} presentation={context.mobile ? mobilePresentation.current : presentation.current} initialPages={navigationPages} projects={visibleProjects} selected={selected} expanded={expanded} context={context}
      onToggle={id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
      onPrivate={id => { if (selected) choose(null, id); else if (id) context.openConversation(id); else context.newConversation(); }}
      onOpen={(id, conversationId) => { setExpanded(previous => new Set([...previous, id])); if (id === selected) { if (conversationId) context.openConversation(conversationId); else context.newConversation(); } else choose(id, conversationId); }}
      onManage={admin || personalCapabilities?.canAdminister || teamAvailable && (capabilities?.canManageProjects === true || capabilities?.canCreate || visibleProjects.some(item => canManageProject(item, false))) ? () => {
        if (canLeave()) window.location.assign(project && canManageProject(project, admin) ? `/work/projects/${encodeURIComponent(project.id)}` : "/work/projects");
      } : undefined} /></>;
  };
  const personal: PersonalWorkspaceBinding | undefined = personalCapabilities?.available ? {
    newChatProjectId,
    panelProjectId,
    projects: personalProjects.filter(item => item.status === "active"),
    panel: panelProjectId ? (onDirtyChange, onBusyChange) => <PersonalProjectPanel key={panelProjectId} projectId={panelProjectId} capabilities={personalCapabilities}
      onChanged={() => { setPersonalRefresh(value => value + 1); void refreshPersonal(); }}
      onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} onClose={() => setPanelProjectId(null)} /> : null,
    onClosePanel: () => { if (panelProjectId) { setPanelProjectId(null); } },
    onNewConversation: () => setNewChatProjectId(null),
    onConversationChanged: (conversation: CloudConversation) => { setNewChatProjectId(null); if (conversation.personalProjectId) setPersonalRefresh(value => value + 1); },
  } : undefined;
  return <>
    {selected && !project ? <main className="fixed inset-0 grid place-content-center gap-4 bg-background p-6 text-foreground"><p role="alert">{locked || "This project is unavailable."}</p><Button variant="outline" onClick={() => void open(null)}>Private conversations</Button><Button onClick={() => void open(selected)}>Try again</Button></main> : <div inert={!!locked || loading || undefined} aria-hidden={!!locked || undefined} style={locked ? { visibility: "hidden" } : undefined}><CloudWorkspace key={project?.id ?? "private"} bootstrap={bootstrap} initialSidebarCollapsed={sidebarCollapsed} onSidebarCollapsedChange={setSidebarCollapsed} sidebarScroll={sidebarScroll} initialConversations={navigationPages[project?.id ?? "private"]} admin={admin} viewer={viewer} projectCapabilities={capabilities} project={project ?? undefined} personal={project ? undefined : personal} projectNavigation={navigation} initialConversationId={initialConversationId} onPrivateConversation={() => choose(null)}
      onProjectAccessLost={onProjectAccessLost}
      projectSettings={project ? (onDirtyChange, onBusyChange) => <ProjectMemoryPanel project={project} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} /> : undefined} /></div>}

    <Dialog open={modal === "create-personal"} onClose={() => { if (!busy) setModal(null); }} title="New personal project" description="A private folder for related chats, instructions and reference files. Only you can see it.">
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError(""); try { const next = await createPersonalProject({ requestId: personalCreationId.current ??= crypto.randomUUID(), name: name.trim() }); await refreshPersonal(); setModal(null); if (selected && !await open(null)) return; setPanelProjectId(next.id); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>
        <label className="grid gap-2 text-sm">Project name<input autoFocus className={projectField} maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} required /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create project"}</Button>
      </form>
    </Dialog>
    {project && locked && <div className="fixed inset-0 z-[100] grid place-content-center gap-4 bg-background p-6 text-foreground"><p role="alert">{locked}</p><Button onClick={() => window.dispatchEvent(new Event("online"))}>Try again</Button></div>}
    {personalError && <div role="alert" className="fixed bottom-16 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-background px-4 py-2 text-sm">
      <span>Personal projects: {personalError}</span><Button size="sm" variant="outline" onClick={() => void refreshPersonal()}>Retry</Button>
    </div>}
    {(loading || error && modal !== "create" && modal !== "create-personal") && <div role={error ? "alert" : "status"} className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-background px-4 py-2 text-sm text-muted-foreground">{error || "Loading Cloud Work…"}</div>}
    <Dialog open={modal === "create"} onClose={() => { if (!busy) setModal(null); }} title="New team project" description="Conversations, files, and memory stay inside this project. Share it with members or teams in project settings.">
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError(""); try { const next = await cloudApi<CloudProjectDetail>("/projects", cloudMutation({ requestId: creationId.current ??= crypto.randomUUID(), name: name.trim() })); await refresh(); setModal(null); if (guard.current()) await open(next.id); } catch (failure) { setError(cloudError(failure)); } finally { setBusy(false); } }}>
        <label className="grid gap-2 text-sm">Project name<input autoFocus className={projectField} maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} required /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create project"}</Button>
      </form>
    </Dialog>
  </>;
}
