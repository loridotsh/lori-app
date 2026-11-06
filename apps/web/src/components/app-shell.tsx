"use client";

import type { Viewer, ProjectCapabilities } from "@lori-enterprise/contracts";
import {
  ShieldCheckIcon,
  Building2Icon,
  FolderIcon,
  BriefcaseBusinessIcon,
  ChartNoAxesCombinedIcon,
  ChevronRightIcon,
  LaptopIcon,
  LayoutDashboardIcon,
  MenuIcon,
  ScrollTextIcon,
  UsersIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { WorkModeSwitch } from "@/components/work/cloud/work-mode-switch";
import { AccountMenu, accountName } from "@/components/account-menu";
import { LoriLogo } from "@/components/lori-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useWorkAvailability } from "@/hooks/use-work-availability";
import { useAuthorityRefresh } from "@/hooks/use-authority-refresh";
import { isAdministrator, isPersonalWorkspace } from "@/lib/authority";
import { cloudApi } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";

const navigation = [
  {
    href: "/",
    icon: LayoutDashboardIcon,
    id: "overview",
    label: "Overview",
    ready: true,
  },
  {
    href: "/usage",
    icon: ChartNoAxesCombinedIcon,
    id: "usage",
    label: "Usage",
    ready: true,
    usage: true,
  },
  {
    admin: true,
    href: "/people",
    icon: UsersIcon,
    id: "people",
    label: "People",
    ready: true,
  },
  {
    teamAdmin: true,
    href: "/teams",
    icon: UsersRoundIcon,
    id: "teams",
    label: "Teams",
    ready: true,
  },
  {
    href: "/devices",
    icon: LaptopIcon,
    id: "devices",
    label: "Devices",
    ready: true,
  },
  {
    admin: true,
    href: "/organization",
    icon: Building2Icon,
    id: "organization",
    label: "Access",
    ready: true,
  },
  { href: "/work", icon: BriefcaseBusinessIcon, id: "work", label: "Work", ready: true },
  { href: "/work/projects", icon: FolderIcon, id: "projects", label: "Projects", ready: true },
  {
    admin: true,
    href: "/audit",
    icon: ScrollTextIcon,
    id: "audit",
    label: "Audit log",
    ready: true,
  },
] as const;

export const PersistentShellContext = createContext(false);
export interface ShellMetadata { current: AppShellPage; viewer: Viewer; breadcrumb?: string; wide: boolean }
export const ShellMetadataContext = createContext<((metadata: ShellMetadata) => void) | null>(null);

export type AppShellPage =
  | "projects"
  | "work"
  | "overview"
  | "usage"
  | "people"
  | "teams"
  | "devices"
  | "organization"
  | "audit";

const pageTitles: Record<AppShellPage, string> = {
  projects: "Projects",
  work: "Work",
  overview: "Overview",
  usage: "Usage",
  people: "People",
  teams: "Teams",
  devices: "Devices",
  organization: "Access",
  audit: "Audit log",
};

function Navigation({
  current,
  onNavigate,
  viewer,
}: {
  current: AppShellPage;
  onNavigate?: () => void;
  viewer: Viewer;
}) {
  // Members normally land in Cloud Work; when Work is off they see their access page instead.
  const workAvailable = useWorkAvailability();
  const [workExpanded, setWorkExpanded] = useState(true);
  const [revealWork, setRevealWork] = useState(false);
  const workGroupId = useId();
  const [projectManagement, setProjectManagement] = useState(false);
  useEffect(() => {
    let alive = true; const controller = new AbortController();
    void cloudApi<ProjectCapabilities>("/projects/capabilities", { signal: controller.signal }).then(async value => {
      let visible = value.available && (value.canAdminister || value.canManageProjects === true || value.canCreate);
      if (value.available && !visible) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: { projects: unknown[]; nextCursor?: string | null } = await cloudApi(`/projects?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
          visible = page.projects.length > 0;
          cursor = page.nextCursor ?? null;
          if (cursor && (seen.has(cursor) || seen.size >= 50)) throw new Error("Project discovery is incomplete");
          if (cursor) seen.add(cursor);
        } while (!visible && cursor && !controller.signal.aborted);
      }
      if (alive) setProjectManagement(visible);
    }).catch(() => { if (alive) setProjectManagement(false); });
    return () => { alive = false; controller.abort(); };
  }, [viewer.role, viewer.user.id, viewer.authority?.revision]);
  const administrator = isAdministrator(viewer);
  const personal = isPersonalWorkspace(viewer);
  const availableNavigation = navigation.filter(
    (item) =>
      // These manage other people, and a personal workspace has none.
      !(personal && (item.id === "people" || item.id === "teams" || item.id === "audit")) &&
      (item.id !== "projects" || projectManagement && (administrator || workAvailable !== false)) &&
      (!("admin" in item) || !item.admin || administrator) &&
      (!("teamAdmin" in item) ||
        !item.teamAdmin ||
        administrator ||
        viewer.teamAdmin === true) &&
      (!("usage" in item) ||
        !item.usage ||
        viewer.usageAnalytics?.canView === true),
  );

  return (
    <>
      <nav aria-label="Enterprise navigation" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
        <ul className="space-y-0.5">
          {availableNavigation.map(({ href, icon: Icon, id, label }) => {
            if (id === "projects") return null;
            if (id === "work") {
              const items = [
                { id: "manage", label: administrator ? "Manage Work" : "My Work access", href: "/work", Icon: ShieldCheckIcon },
                ...(availableNavigation.some(item => item.id === "projects") ? [{ id: "projects", label: "Projects", href: "/work/projects", Icon: FolderIcon }] : []),
              ];
              return <li key={id}>
                <button type="button" aria-expanded={workExpanded} aria-controls={workGroupId} onClick={() => { setRevealWork(!workExpanded); setWorkExpanded(!workExpanded); }} className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm font-medium outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40 lg:min-h-9"><BriefcaseBusinessIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="flex-1">Work</span><ChevronRightIcon aria-hidden className={cn("size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none", workExpanded && "rotate-90")} /></button>
                {workExpanded && <ul id={workGroupId} aria-label="Work management" className={cn("ml-5 mt-1 space-y-0.5 border-l border-sidebar-border pl-2", revealWork && "motion-safe:animate-reveal")}>{items.map(item => {
                  const selected = item.id === "projects" ? current === "projects" : current === "work";
                  const classes = cn("flex min-h-11 items-center gap-2.5 rounded-md px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 lg:min-h-9", selected ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground");
                  return <li key={item.id}><Link href={item.href} aria-current={selected ? "page" : undefined} onClick={onNavigate} className={classes}><item.Icon aria-hidden className={cn("size-4 shrink-0", selected && "text-primary")} /><span>{item.label}</span></Link></li>;
                })}</ul>}
              </li>;
            }
            const active = current === id;
            return (
              <li key={id}>
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:min-h-9",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
                  )}
                  href={href}
                  onClick={onNavigate}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        className="border-t border-sidebar-border px-6 py-4"
        title={`${accountName(viewer)} (${viewer.user.email}) · ${viewer.organization.name}`}
      >
        <p className="truncate text-xs font-medium text-foreground">
          {accountName(viewer)}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {personal ? "Personal account" : viewer.role === "owner" ? "Owner" : administrator ? "Administrator" : "Member"}
        </p>
      </div>
    </>
  );
}

export function AppShell({
  breadcrumb,
  children,
  current,
  viewer,
  wide = false,
}: {
  breadcrumb?: string;
  children: ReactNode;
  current: AppShellPage;
  viewer: Viewer;
  wide?: boolean;
}) {
  const mobileNavigation = useRef<HTMLDialogElement>(null);
  const insidePersistentShell = useContext(PersistentShellContext);
  // The persistent shell around this page already watches for authority changes.
  useAuthorityRefresh(viewer, !insidePersistentShell);
  const publishMetadata = useContext(ShellMetadataContext);
  useLayoutEffect(() => {
    if (insidePersistentShell) publishMetadata?.({ current, viewer, breadcrumb, wide });
  }, [insidePersistentShell, publishMetadata, current, viewer, breadcrumb, wide]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const closeAtDesktop = () => {
      if (media.matches) mobileNavigation.current?.close();
    };
    media.addEventListener("change", closeAtDesktop);
    return () => media.removeEventListener("change", closeAtDesktop);
  }, []);

  if (insidePersistentShell) return <>{children}</>;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-5">
          <Link aria-label="Lori Enterprise overview" href="/">
            <LoriLogo label={viewer.cloud ? "Lori" : undefined} />
          </Link>
        </div>
        <Navigation current={current} viewer={viewer} />
      </aside>

      <dialog
        aria-label="Navigation"
        className="m-0 h-dvh max-h-none w-[min(18rem,calc(100vw-1.5rem))] max-w-none border-0 bg-sidebar p-0 text-sidebar-foreground open:animate-sheet-in backdrop:animate-backdrop-in lg:hidden"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            mobileNavigation.current?.close();
          }
        }}
        ref={mobileNavigation}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-5">
            <Link
              aria-label="Lori Enterprise overview"
              href="/"
              onClick={() => mobileNavigation.current?.close()}
            >
              <LoriLogo label={viewer.cloud ? "Lori" : undefined} />
            </Link>
            <Button
              aria-label="Close navigation"
              onClick={() => mobileNavigation.current?.close()}
              size="icon"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
          <Navigation
            current={current}
            onNavigate={() => mobileNavigation.current?.close()}
            viewer={viewer}
          />
        </div>
      </dialog>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <Button
              aria-label="Open navigation"
              className="lg:hidden"
              onClick={() => mobileNavigation.current?.showModal()}
              size="icon"
              variant="ghost"
            >
              <MenuIcon />
            </Button>
            <nav
              aria-label="Breadcrumb"
              className="hidden min-w-0 items-center gap-1.5 min-[400px]:flex"
            >
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {viewer.organization.name}
              </span>
              <ChevronRightIcon
                aria-hidden
                className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:inline"
              />
              <span className="truncate text-sm text-muted-foreground">
                {pageTitles[current]}
              </span>
              {breadcrumb ? (
                <>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground/60"
                  />
                  <span className="truncate text-sm font-medium text-foreground">
                    {breadcrumb}
                  </span>
                </>
              ) : null}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <WorkModeSwitch mode="manage" />
            <ThemeToggle />
            <div aria-hidden className="hidden h-4 w-px bg-border sm:block" />
            <AccountMenu viewer={viewer} />
          </div>
        </header>

        <main
          className={cn(
            "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8",
            wide ? "max-w-7xl" : "max-w-5xl",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
