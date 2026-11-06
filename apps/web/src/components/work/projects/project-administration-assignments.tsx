"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectManagementPage } from "@lori-enterprise/contracts";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";

/** Rendered only in org-admin People/Teams screens; the API rechecks authority. */
export function ProjectAdministrationAssignments({ memberId, teamId }: { memberId?: string; teamId?: string }) {
  const [page, setPage] = useState<ProjectManagementPage | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setPage(null); setError("");
    const load = async () => {
      const query = new URLSearchParams({ limit: "5", ...(memberId ? { memberId } : {}), ...(teamId ? { teamId } : {}) });
      try {
        const value = await cloudApi<ProjectManagementPage>(`/projects/management?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setPage(value); setError(""); }
      } catch (failure) { if (!controller.signal.aborted) { setPage(null); setError(cloudError(failure)); } }
    };
    void load(); const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [memberId, teamId, retry]);
  const query = new URLSearchParams({ ...(memberId ? { memberId } : {}), ...(teamId ? { teamId } : {}) });
  return <section aria-label="Project assignments" className="space-y-3 border-t border-border pt-5"><h2 className="text-sm font-semibold">Project assignments</h2><p className="text-xs leading-5 text-muted-foreground">Review existing access assignments. Open a project to manage its roles, restrictions, and blocks.</p>{error ? <div className="text-xs"><p role="alert" className="text-destructive">{error}</p><button type="button" className="mt-2 rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : !page ? <p role="status" className="text-xs text-muted-foreground">Loading assignments…</p> : <><ul className="flex flex-wrap gap-x-5 gap-y-2">{page.projects.map(project => <li key={project.id}><Link href={`/work/projects/${project.id}`} className="rounded text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{project.name}</Link></li>)}</ul>{!page.projects.length && <p className="text-sm text-muted-foreground">No projects are assigned through this {memberId ? "member" : "team"}.</p>}<Link href={`/work/projects?${query}`} className="inline-block rounded text-xs text-muted-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">View all assigned projects</Link></>}</section>;
}
