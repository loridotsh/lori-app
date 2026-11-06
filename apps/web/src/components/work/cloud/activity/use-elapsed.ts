"use client";

import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { useEffect, useState } from "react";
import type { ToolKind } from "./tool-presentation";

/** Whole seconds since `since`, ticking once a second while `active`; 0 when idle or the date is unreadable. */
export function useElapsed(since: string | undefined, active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = since ? Date.parse(since) : NaN;
    if (!active || !Number.isFinite(start)) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since, active]);
  return seconds;
}

/** What an approved tool is doing right now, in plain words. */
export function stageLabel(
  status: CloudToolInvocation["status"],
  kind: ToolKind,
): string {
  if (status === "pendingExecution") return "Queued for the worker";
  return kind === "command"
    ? "Running in the sandbox"
    : kind === "document"
      ? "Working on the document"
      : "Working";
}

/** `8s`, `1m 05s`: compact and steady-width digits. */
export function clock(seconds: number): string {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
