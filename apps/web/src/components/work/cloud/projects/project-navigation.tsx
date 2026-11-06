"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CloudConversation, CloudConversationPage, CloudProject, CloudRunStatus, PersonalProject } from "@lori-enterprise/contracts";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react";
import { PersonalProjectRow, usePersonalExpansion, type PersonalRowHandlers } from "../personal/personal-navigation";
import { NewProjectMenu } from "./new-project-menu";
import type { CreationKind, CreationOption } from "./project-creation";
import { cloudApi, cloudError, validateCloudConversationPage } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { ConversationStatus } from "../conversation-status";

export interface ProjectNavigationContext {
  mobile?: boolean;
  conversationId: string | null;
  runStatus?: CloudRunStatus | null;
  conversations: CloudConversation[];
  disabled: boolean;
  query?: string;
  openConversation: (id: string) => void;
  newConversation: () => boolean | void;
  /** The personal project the open conversation is filed in. */
  personalProjectId?: string | null;
  revision?: number;
}
const row = "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none";
const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const merge = (items: CloudConversation[]) => [...new Map(items.map(item => [item.id, item])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
export type NavigationPresentation = Map<string, { more: boolean; count: number }>;

function ProjectRow({ project, active, expanded, toggle, context, onOpen, initialPage, presentation }: {
  presentation?: NavigationPresentation;
  initialPage?: CloudConversationPage;
  project: CloudProject; active: boolean; expanded: boolean; toggle: () => void;
  context: ProjectNavigationContext; onOpen: (projectId: string, conversationId?: string) => void;
}) {
  const id = useId();
  // The workspace remounts on every project switch, so only a folder the
  // member just opened reveals; folders that were already open stay still.
  const [reveal, setReveal] = useState(false);
  const [page, setPage] = useState<CloudConversationPage | null>(expanded ? initialPage ?? null : null);
  const previousScope = useRef({ id: project.id, revision: project.accessRevision, expanded });
  const [more, setMore] = useState(presentation?.get(project.id)?.more ?? false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const hasPage = useRef(!!page);
  hasPage.current = !!page;
  useEffect(() => { if (page) presentation?.set(project.id, { more, count: page.conversations.length }); }, [page, more, presentation, project.id]);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    // Reauthorize every expansion. A collapsed project's content is not cached.
    const previous = previousScope.current;
    if (previous.id !== project.id || previous.revision !== project.accessRevision || previous.expanded !== expanded) {
      setPage(null); setMore(false); setError("");
    }
    previousScope.current = { id: project.id, revision: project.accessRevision, expanded };
  }, [project.id, project.accessRevision, expanded]);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController(); request.current = controller; setLoading(!hasPage.current);
    void cloudApi<CloudConversationPage>(`/projects/${project.id}/conversations?limit=5`, { signal: controller.signal })
      .then(validateCloudConversationPage)
      .then(value => { if (!controller.signal.aborted) setPage(previous => previous ? { ...previous, conversations: merge([...previous.conversations, ...value.conversations]) } : value); })
      .catch(failure => { if (!controller.signal.aborted) { setPage(null); setError(cloudError(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [project.id, project.accessRevision, expanded, retry]);
  useEffect(() => {
    if (!expanded) return;
    const verify = () => setRetry(value => value + 1);
    const timer = window.setInterval(verify, 5000);
    const offline = () => { request.current?.abort(); setPage(null); setLoading(false); setError("Connect to Enterprise to load project conversations."); };
    window.addEventListener("focus", verify); window.addEventListener("online", verify); window.addEventListener("offline", offline);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", verify); window.removeEventListener("online", verify); window.removeEventListener("offline", offline); };
  }, [expanded]);
  const rows = page ? merge([...page.conversations, ...(active ? context.conversations : [])]) : [];
  const query = active ? context.query?.trim().toLocaleLowerCase() ?? "" : "";
  const matches = query ? rows.filter(item => item.title.toLocaleLowerCase().includes(query)) : rows;
  const selected = active && context.conversationId ? rows.find(item => item.id === context.conversationId) : undefined;
  const preview = matches.slice(0, 5);
  // Keep the current chat visible without exceeding the five-row preview.
  const shown = query || more ? matches : selected && !preview.some(item => item.id === selected.id) ? [...preview.slice(0, 4), selected] : preview;
  const hasMore = !!page?.nextCursor || rows.length > 5;
  const loadMore = async () => {
    if (loading || !page) return;
    setMore(true);
    if (!page.nextCursor) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError("");
    try {
      const next = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`/projects/${project.id}/conversations?limit=30&cursor=${encodeURIComponent(page.nextCursor)}`, { signal: controller.signal }));
      if (!controller.signal.aborted) setPage(previous => ({ conversations: merge([...(previous?.conversations ?? []), ...next.conversations]), nextCursor: next.nextCursor }));
    } catch (failure) { if (!controller.signal.aborted) { if (failure instanceof ClientApiError && [401,403,404].includes(failure.status)) setPage(null); setError(cloudError(failure)); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const conversation = (item: CloudConversation) => <li key={item.id}><button type="button" title={item.title || "Untitled conversation"} disabled={context.disabled}
    aria-current={active && context.conversationId === item.id ? "page" : undefined}
    onClick={() => active ? context.openConversation(item.id) : onOpen(project.id, item.id)}
    className={cn(row, "min-h-8 pl-3", active && context.conversationId === item.id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
    <span className="min-w-0 flex-1 truncate">{item.title || "Untitled conversation"}</span><ConversationStatus status={active && context.conversationId === item.id ? context.runStatus ?? item.latestRunStatus : page?.conversations.find(row => row.id === item.id)?.latestRunStatus ?? item.latestRunStatus} />
  </button></li>;
  return <li>
    <div className={cn("group flex min-w-0 items-center rounded-md", active && "bg-sidebar-accent/50")}>
      <button type="button" className={cn(row, "flex-1 font-medium")} title={project.name} aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded} aria-controls={id} onClick={() => { setReveal(!expanded); toggle(); }}>
        <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
        {expanded ? <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {project.status === "archived" && <span className="text-[11px] font-normal text-muted-foreground">Archived</span>}
        <span className="sr-only">Team project</span>
      </button>
      <span aria-hidden title="Team project" className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"><UsersIcon className="size-3.5" data-project-kind="team" /></span>
      {!project.access.actions.includes("chat") && <span aria-hidden className="size-8 shrink-0" />}
      {project.access.actions.includes("chat") && <button type="button" className={iconButton} title={`New conversation in ${project.name}`} aria-label={`New conversation in ${project.name}`} disabled={context.disabled} onClick={() => active ? context.newConversation() : onOpen(project.id)}><PlusIcon aria-hidden className="size-3.5" /></button>}
    </div>
    {expanded && <div id={id} className={cn("ml-4 border-l border-sidebar-border pl-2 pt-0.5", reveal && "motion-safe:animate-reveal")}>
      <ul aria-label={`${project.name} conversations`} className="space-y-0.5">{shown.map(conversation)}</ul>
      {loading && !page && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading conversations…</p>}
      {!loading && page && !rows.length && <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">No conversations yet.</p>}
      {query && page && !matches.length && <p role="status" className="px-3 py-2 text-xs leading-5 text-muted-foreground">{page.nextCursor ? "No match in loaded conversations. Use More to search older chats." : "No matching conversations."}</p>}
      {error && <div className="px-3 py-2 text-xs"><p role="alert" className="text-destructive">{error}</p><button type="button" className="mt-1 rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => page ? void loadMore() : setRetry(value => value + 1)}>Try again</button></div>}
      {hasMore && (!more || page?.nextCursor) && <button type="button" className={cn(row, "min-h-8 pl-3 text-xs text-muted-foreground")} disabled={loading} onClick={() => void loadMore()} aria-label={`More conversations in ${project.name}`}>{loading ? "Loading…" : "More"}<ChevronRightIcon className="size-3" aria-hidden /></button>}
      {more && rows.length > 5 && <button type="button" className={cn(row, "min-h-8 pl-3 text-xs text-muted-foreground")} disabled={loading} onClick={() => setMore(false)}>Show less</button>}
    </div>}
  </li>;
}

export interface PersonalNavigationProps extends PersonalRowHandlers { projects: PersonalProject[] }
export interface CreationControl { options: CreationOption[]; onChoose: (kind: CreationKind) => void }
type Entry = { kind: "team"; project: CloudProject } | { kind: "personal"; project: PersonalProject };
const byRecency = (a: Entry, b: Entry) => b.project.updatedAt.localeCompare(a.project.updatedAt) || a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id);

/** Team workspaces and the member's personal projects in one list, newest first; a small icon on each row tells them apart. */
export function ProjectNavigation({ projects, personal, selected, expanded, onToggle, context, onOpen, onPrivate, creation, onManage, initialPages, presentation }: {
  presentation?: NavigationPresentation;
  initialPages?: Record<string, CloudConversationPage>;
  projects: CloudProject[]; personal?: PersonalNavigationProps; selected: string | null; expanded: ReadonlySet<string>; onToggle: (id: string) => void;
  context: ProjectNavigationContext; onOpen: (projectId: string, conversationId?: string) => void; onPrivate: (conversationId?: string) => void;
  creation?: CreationControl; onManage?: () => void;
}) {
  const personalExpansion = usePersonalExpansion(personal?.activeProjectId ?? null);
  const entries: Entry[] = [
    ...projects.map(project => ({ kind: "team" as const, project })),
    ...(personal?.projects ?? []).filter(project => project.status !== "deleted").map(project => ({ kind: "personal" as const, project })),
  ].sort(byRecency);
  const canCreate = !!creation?.options.length;
  return <><nav aria-label="Projects" className="mb-4">
    <div className="mb-1 flex items-center justify-between pl-2.5"><h2 className="text-xs font-medium text-muted-foreground">Projects</h2><div className="flex">
      {creation && <NewProjectMenu options={creation.options} disabled={context.disabled} onChoose={creation.onChoose} />}
      {onManage && <button type="button" className={iconButton} title="Manage projects" aria-label="Manage projects" disabled={context.disabled} onClick={onManage}><SettingsIcon className="size-3.5" aria-hidden /></button>}
    </div></div>
    <ul className="space-y-1">{entries.map(entry => entry.kind === "team"
      ? <ProjectRow key={`team:${entry.project.id}`} presentation={presentation} initialPage={initialPages?.[entry.project.id]} project={entry.project} active={selected === entry.project.id} expanded={expanded.has(entry.project.id)} toggle={() => onToggle(entry.project.id)} context={context} onOpen={onOpen} />
      : <PersonalProjectRow key={`personal:${entry.project.id}`} project={entry.project} expanded={personalExpansion.expanded.has(entry.project.id)} onToggle={() => personalExpansion.toggle(entry.project.id)} context={context}
          handlers={{ ...personal!, onNew: id => { personalExpansion.open(id); personal!.onNew(id); } }} />)}</ul>
    {!entries.length && <p className="px-2.5 py-1 text-xs leading-5 text-muted-foreground">{canCreate ? "Create a project to organize your work. Personal projects are private to you; team projects are shared." : "Projects shared with you will appear here."}</p>}
    {personal && personal.projects.some(project => project.status === "deleted") && <details className="mt-3 px-2.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded py-2 focus-visible:ring-2 focus-visible:ring-ring">Deleted personal projects</summary>
      <ul aria-label="Deleted personal projects">
        {personal.projects.filter(project => project.status === "deleted").map(project => <li key={project.id}>
          <button type="button" className={row} disabled={context.disabled} onClick={() => personal.onSettings(project.id)} aria-label={`Recover ${project.name}`}>
            <span className="truncate">{project.name}</span><span className="ml-auto text-xs">Recover</span>
          </button>
        </li>)}
      </ul>
    </details>}
  </nav>{selected && <PrivateConversations initialPage={initialPages?.private} context={context} onOpen={onPrivate} />}</>;
}

function PrivateConversations({ context, onOpen, initialPage }: { initialPage?: CloudConversationPage; context: ProjectNavigationContext; onOpen: (id?: string) => void }) {
  const [page, setPage] = useState<CloudConversationPage | null>(initialPage ?? null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setRetry(value => value + 1), 5000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; setLoading(true); setError("");
    void cloudApi<CloudConversationPage>("/conversations", { signal: controller.signal }).then(validateCloudConversationPage).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(f => { if (!controller.signal.aborted) setError(cloudError(f)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [retry]);
  const more = async () => {
    if (!page?.nextCursor || loading) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try { const next = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`/conversations?cursor=${encodeURIComponent(page.nextCursor)}`, { signal: controller.signal })); if (!controller.signal.aborted) setPage(old => ({ conversations: merge([...(old?.conversations ?? []), ...next.conversations]), nextCursor: next.nextCursor })); }
    catch (f) { if (!controller.signal.aborted) setError(cloudError(f)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <section aria-label="Private conversations"><h2 className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">Conversations</h2>
    <ul>{page?.conversations.map(item => <li key={item.id}><button type="button" className={cn(row, "min-h-8 text-muted-foreground")} disabled={context.disabled} title={item.title} onClick={() => onOpen(item.id)}><span className="min-w-0 flex-1 truncate">{item.title || "Untitled conversation"}</span><ConversationStatus status={item.latestRunStatus} /></button></li>)}</ul>
    {loading && !page && <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">Loading conversations…</p>}
    {!loading && page && !page.conversations.length && <p className="px-2.5 py-2 text-xs text-muted-foreground">Your normal conversations will appear here.</p>}
    {error && <div className="px-2.5 py-2 text-xs"><p role="alert">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {page?.nextCursor && <button type="button" className={cn(row, "text-xs")} disabled={loading} onClick={() => void more()}>More conversations</button>}
  </section>;
}
