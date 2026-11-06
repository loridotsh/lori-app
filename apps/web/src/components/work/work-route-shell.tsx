"use client";

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { Viewer } from "@lori-enterprise/contracts";
import { usePathname } from "next/navigation";
import { AppShell, PersistentShellContext, ShellMetadataContext, type ShellMetadata, type AppShellPage } from "@/components/app-shell";

/** Keep navigation mounted while only the authorized route content loads. */
export function WorkRouteShell({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const pathname = usePathname();
  const section = pathname.split("/")[1] ?? "";
  const projects = pathname === "/work/projects" || pathname.startsWith("/work/projects/");
  const sections: Record<string, AppShellPage> = { "": "overview", work: "work", organization: "organization", people: "people", teams: "teams", devices: "devices", usage: "usage", audit: "audit" };
  const current = projects ? "projects" : sections[section];
  const [registered, setRegistered] = useState<{ path: string; metadata: ShellMetadata } | null>(null);
  const publish = useCallback((metadata: ShellMetadata) => {
    if (metadata.current !== current) return;
    setRegistered(previous => previous?.path === pathname && JSON.stringify(previous.metadata) === JSON.stringify(metadata) ? previous : { path: pathname, metadata });
  }, [pathname, current]);
  if (!current || pathname === "/work/cloud" || pathname.startsWith("/work/cloud/")) return children;
  const metadata = registered?.path === pathname ? registered.metadata : null;
  return <AppShell viewer={metadata?.viewer ?? viewer} current={current}
    wide={metadata?.wide ?? (pathname === "/work/projects" || pathname.endsWith("/usage"))} breadcrumb={metadata?.breadcrumb ?? (projects && pathname !== "/work/projects" ? "Project details" : undefined)}>
    <PersistentShellContext.Provider value><ShellMetadataContext.Provider value={publish}>{children}</ShellMetadataContext.Provider></PersistentShellContext.Provider>
  </AppShell>;
}
