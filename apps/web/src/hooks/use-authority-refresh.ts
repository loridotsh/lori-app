"use client";

import type { Viewer } from "@lori-enterprise/contracts";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ClientApiError, clientApi } from "@/lib/client-api";

/** What decides which pages and controls a viewer may use; ordinary policy edits do not change it. */
export function authoritySignature(viewer: Viewer): string {
  return [
    viewer.user.id,
    viewer.organization.id,
    viewer.role,
    viewer.teamAdmin ? "team-admin" : "",
    viewer.usageAnalytics?.canView ? "usage" : "",
    [...(viewer.authority?.capabilities ?? [])].sort().join(","),
    viewer.authority?.ownerAssigned === false ? "no-owner" : "",
  ].join("|");
}

/**
 * Re-renders server-provided authority when it changed elsewhere (another tab,
 * another admin, a different account) and the person returns to the page.
 * It refreshes only on a real authority change, so drafts survive ordinary use.
 */
export function useAuthorityRefresh(viewer: Viewer, enabled = true): void {
  const router = useRouter();
  const signature = authoritySignature(viewer);
  const organizationId = viewer.organization.id;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let last = Date.now();
    const check = async () => {
      if (document.visibilityState === "hidden" || Date.now() - last < 30_000) return;
      last = Date.now();
      try {
        const latest = await clientApi<Viewer>("/v1/me");
        if (stopped) return;
        // Another tab changed workspace: nothing on this page belongs to it.
        if (latest.organization.id !== organizationId) window.location.assign("/");
        else if (authoritySignature(latest) !== signature) router.refresh();
      } catch (error) {
        if (!stopped && error instanceof ClientApiError && [401, 403].includes(error.status))
          router.refresh();
      }
    };
    const onEvent = () => void check();
    window.addEventListener("focus", onEvent);
    window.addEventListener("online", onEvent);
    document.addEventListener("visibilitychange", onEvent);
    return () => {
      stopped = true;
      window.removeEventListener("focus", onEvent);
      window.removeEventListener("online", onEvent);
      document.removeEventListener("visibilitychange", onEvent);
    };
  }, [enabled, organizationId, router, signature]);
}
