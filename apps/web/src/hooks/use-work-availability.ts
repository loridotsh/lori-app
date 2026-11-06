"use client";

import { useEffect, useState } from "react";
import { ClientApiError } from "@/lib/client-api";
import { workApi } from "@/lib/work-api";

const FRESH_MS = 15_000;
let cached: { enabled: boolean; at: number } | null = null;
let inflight: Promise<boolean | null> | null = null;

async function fetchAvailability(): Promise<boolean | null> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.enabled;
  inflight ??= workApi<{ contractVersion?: number; enabled?: unknown }>(
    "/v1/work/cloud/capabilities",
    { cache: "no-store" },
  )
    .then((value) => {
      if (typeof value.enabled !== "boolean") return null;
      cached = { enabled: value.enabled, at: Date.now() };
      return value.enabled;
    })
    .catch((failure: unknown) => {
      // Work denied outright is a definitive "off"; anything else is unknown.
      if (
        failure instanceof ClientApiError &&
        failure.status === 403 &&
        failure.code === "work_disabled"
      ) {
        cached = { enabled: false, at: Date.now() };
        return false;
      }
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Whether Work is enabled for the signed-in member. `null` while unknown or
 * when it cannot be determined, so controls are only disabled on a definite
 * "off". The server remains the authority; this only shapes the interface.
 */
export function useWorkAvailability(
  skip = false,
  /** The server's answer at render time, shown until the first client check. */
  initial: boolean | null = null,
): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(
    cached ? cached.enabled : initial,
  );
  useEffect(() => {
    if (skip) return;
    let active = true;
    const refresh = () => {
      void fetchAvailability().then((value) => {
        if (active && value !== null) setEnabled(value);
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(WORK_ACCESS_CHANGED, refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(WORK_ACCESS_CHANGED, refresh);
    };
  }, [skip]);
  return enabled;
}

const WORK_ACCESS_CHANGED = "lori:work-access-changed";

/** Call after Work access is saved so every open indicator re-reads it immediately. */
export function notifyWorkAccessChanged() {
  cached = null;
  inflight = null;
  window.dispatchEvent(new Event(WORK_ACCESS_CHANGED));
}

/** Test seam: forget the shared result between cases. */
export function resetWorkAvailabilityCache() {
  cached = null;
  inflight = null;
}
