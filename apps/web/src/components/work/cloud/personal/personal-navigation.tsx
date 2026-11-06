"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CloudConversation, CloudConversationPage, PersonalProject } from "@lori-enterprise/contracts";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, PlusIcon, SettingsIcon, UserIcon } from "lucide-react";
import { cloudApi, cloudError, validateCloudConversationPage } from "@/lib/cloud-work-api";
import { personalPath } from "@/lib/personal-projects-api";
import { cn } from "@/lib/utils";
import { ConversationStatus } from "../conversation-status";
import type { ProjectNavigationContext } from "../projects/project-navigation";

const row =
  "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none";
const iconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const kindIcon = "absolute inset-0 size-3.5 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none";
const newest = (items: CloudConversation[]) =>
  [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));

export interface PersonalRowHandlers {
  /** The project the open conversation is filed in. */
  activeProjectId: string | null;
  /** The project whose instructions and files are showing. */
  panelProjectId: string | null;
  refreshKey: string;
  onOpen: (projectId: string, conversationId: string) => void;
  onNew: (projectId: string) => void;
  onSettings: (projectId: string) => void;
}

/** Which personal projects are open. The project of the chat being read opens by itself, once, so the chat is findable. */
export function usePersonalExpansion(activeProjectId: string | null) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seeded = useRef(false);
  useEffect(() => {
    if (activeProjectId && !seeded.current) {
      seeded.current = true;
      setExpanded((previous) => new Set([...previous, activeProjectId]));
    }
  }, [activeProjectId]);
  const toggle = useCallback((id: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  const open = useCallback((id: string) => setExpanded((previous) => new Set([...previous, id])), []);
  return { expanded, toggle, open };
}

export function PersonalProjectRow({
  project,
  expanded,
  context,
  handlers,
  onToggle,
}: {
  project: PersonalProject;
  expanded: boolean;
  context: ProjectNavigationContext;
  handlers: PersonalRowHandlers;
  onToggle: () => void;
}) {
  const listId = useId();
  const [page, setPage] = useState<CloudConversationPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const visibleCount = useRef(6);
  const archived = project.status === "archived";
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const read = async () => {
      const target = visibleCount.current;
      const value = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`${personalPath}/${project.id}/conversations?limit=${Math.min(50, target)}`, { signal: controller.signal }));
      const seen = new Set<string>();
      while (value.nextCursor && value.conversations.length < target) {
        if (seen.has(value.nextCursor)) throw new Error("Conversation pagination did not advance.");
        seen.add(value.nextCursor);
        const next = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`${personalPath}/${project.id}/conversations?limit=50&cursor=${encodeURIComponent(value.nextCursor)}`, { signal: controller.signal }));
        value.conversations.push(...next.conversations);
        value.nextCursor = next.nextCursor;
      }
      return value;
    };
    void read()
      .then((value) => {
        if (controller.signal.aborted) return;
        setPage(value);
        setError("");
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(cloudError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => { controller.abort(); request.current?.abort(); };
  }, [expanded, project.id, project.updatedAt, handlers.refreshKey, retry]);
  const loadMore = async () => {
    if (loading || !page?.nextCursor) return;
    const cursor = page.nextCursor;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = validateCloudConversationPage(await cloudApi<CloudConversationPage>(`${personalPath}/${project.id}/conversations?limit=50&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      if (next.nextCursor === cursor) throw new Error("Conversation pagination did not advance.");
      const conversations = newest([...page.conversations, ...next.conversations]);
      visibleCount.current = Math.max(6, conversations.length);
      setPage({ conversations, nextCursor: next.nextCursor });
    } catch (failure) {
      if (!controller.signal.aborted) setError(cloudError(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    if (!expanded) return;
    const again = () => setRetry((value) => value + 1);
    const timer = window.setInterval(again, 15000);
    window.addEventListener("focus", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [expanded]);
  const active = handlers.activeProjectId === project.id;
  const panelOpen = handlers.panelProjectId === project.id;
  const rows = page ? newest(page.conversations) : [];
  const query = context.query?.trim().toLocaleLowerCase() ?? "";
  const shown = query ? rows.filter((item) => item.title.toLocaleLowerCase().includes(query)) : rows;
  return (
    <li>
      <div className={cn("group flex min-w-0 items-center rounded-md", (active || panelOpen) && "bg-sidebar-accent/50")}>
        <button
          type="button"
          className={cn(row, "flex-1 font-medium")}
          title={`${project.name} · Personal project, only you can see it`}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
        >
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
          {expanded ? <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {archived && <span className="text-[11px] font-normal text-muted-foreground">Archived</span>}
          <span className="sr-only">Personal project</span>
        </button>
        <button
          type="button"
          className={cn(iconButton, "group/kind", panelOpen && "bg-sidebar-accent text-foreground")}
          title="Project settings · instructions and files"
          aria-label={`Instructions and files for ${project.name}`}
          aria-current={panelOpen ? "page" : undefined}
          disabled={context.disabled}
          onClick={() => handlers.onSettings(project.id)}
        >
          <span aria-hidden className="relative size-3.5">
            <UserIcon data-project-kind="personal" className={cn(kindIcon, "opacity-100 group-hover/kind:scale-90 group-hover/kind:opacity-0 group-focus-visible/kind:scale-90 group-focus-visible/kind:opacity-0 group-aria-[current=page]/kind:scale-90 group-aria-[current=page]/kind:opacity-0")} />
            <SettingsIcon className={cn(kindIcon, "scale-90 opacity-0 group-hover/kind:scale-100 group-hover/kind:opacity-100 group-focus-visible/kind:scale-100 group-focus-visible/kind:opacity-100 group-aria-[current=page]/kind:scale-100 group-aria-[current=page]/kind:opacity-100")} />
          </span>
        </button>
        {archived ? (
          <span aria-hidden className="size-8 shrink-0" />
        ) : (
          <button type="button" className={iconButton} title={`New conversation in ${project.name}`} aria-label={`New conversation in ${project.name}`} disabled={context.disabled} onClick={() => handlers.onNew(project.id)}>
            <PlusIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {expanded && (
        <div id={listId} className="ml-4 border-l border-sidebar-border pl-2 pt-0.5">
          <ul aria-label={`${project.name} conversations`} className="space-y-0.5">
            {shown.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  title={item.title || "Untitled conversation"}
                  disabled={context.disabled}
                  aria-current={context.conversationId === item.id ? "page" : undefined}
                  onClick={() => handlers.onOpen(project.id, item.id)}
                  className={cn(row, "min-h-8 pl-3", context.conversationId === item.id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  <span className="min-w-0 flex-1 truncate">{item.title || "Untitled conversation"}</span>
                  <ConversationStatus status={context.conversationId === item.id ? context.runStatus ?? item.latestRunStatus : item.latestRunStatus} />
                </button>
              </li>
            ))}
          </ul>
          {loading && !page && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading conversations…</p>}
          {!loading && page && !rows.length && <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">No conversations yet.</p>}
          {query && page && rows.length > 0 && !shown.length && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">No matching conversations.</p>}
          {error && (
            <div className="px-3 py-2 text-xs">
              <p role="alert" className="text-destructive">{error}</p>
              <button type="button" className="mt-1 rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setRetry((value) => value + 1)}>Try again</button>
            </div>
          )}
          {page?.nextCursor && (
            <button type="button" className={cn(row, "min-h-8 pl-3 text-xs text-muted-foreground")} disabled={loading} onClick={() => void loadMore()} aria-label={`More conversations in ${project.name}`}>
              More
              <ChevronRightIcon className="size-3" aria-hidden />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
