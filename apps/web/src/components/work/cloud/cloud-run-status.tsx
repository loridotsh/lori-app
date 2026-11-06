"use client";

import {
  AlertTriangleIcon,
  InfoIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { CloudApproval, CloudToolInvocation } from "@lori-enterprise/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CloudRunProblem } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { ShimmerText } from "./shimmer-text";

/** How long a run may wait for a worker before the member is told something may be wrong. */
const SLOW_QUEUE_SECONDS = 20;

function useElapsedSeconds(since: string | undefined) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = since ? Date.parse(since) : Date.now();
    const tick = () =>
      setSeconds(
        Math.max(0, Math.floor((Date.now() - (started || Date.now())) / 1000)),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return seconds;
}

/**
 * The pending-response row: a shimmering status line, and a hint when a
 * worker has not picked the run up. Replaces a bare status string.
 */
export function ThinkingIndicator({
  status,
  label,
  since,
  workerAvailable,
  hasText,
  text = "",
  connectionStatus = "",
  approvals = [],
}: {
  status: "queued" | "running" | "awaitingApproval";
  label?: string;
  since?: string;
  workerAvailable: boolean;
  hasText: boolean;
  text?: string;
  connectionStatus?: string;
  /** Accepted for callers that still pass it; tools describe themselves in their own rows. */
  invocations?: CloudToolInvocation[];
  approvals?: CloudApproval[];
}) {
  const elapsed = useElapsedSeconds(since);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    if (!text) { setWriting(false); return; }
    setWriting(true);
    const timer = setTimeout(() => setWriting(false), 1800);
    return () => clearTimeout(timer);
  }, [text]);
  const waitingOnYou = status === "awaitingApproval" || approvals.some((item) => item.status === "pending");
  const reconnecting = /^(Reconnecting|Live updates paused)/.test(connectionStatus);
  // A running tool already says what it is doing in its own row; repeating its
  // title here would show the same work twice. This line is only about the model.
  const currentLabel = waitingOnYou ? "Waiting for your approval"
    : reconnecting ? connectionStatus
    : status === "queued" ? "Waiting for a worker"
    : label ?? (writing ? "Writing" : "Thinking");
  // Shimmer only while Lori is the one working: not while waiting on the member or a dropped connection.
  const working = !waitingOnYou && !reconnecting;
  const stalled =
    status === "queued" && (elapsed >= SLOW_QUEUE_SECONDS || !workerAvailable);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-col gap-1", hasText && "mt-3")}
    >
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
        {waitingOnYou ? <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-warning-muted-foreground" /> : null}
        <ShimmerText active={working} className="min-w-0 truncate" title={currentLabel}>
          {currentLabel}
        </ShimmerText>
        {elapsed >= 5 && !waitingOnYou ? (
          // The clock is visual only: a polite live region must not read out every second.
          <span
            aria-hidden="true"
            className="tabular-nums text-xs text-muted-foreground/70"
          >
            {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
          </span>
        ) : null}
      </div>
      {stalled ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {workerAvailable
            ? "Still waiting for a worker to pick this up. It will start automatically."
            : "No worker is online right now. Ask an administrator to check that the Cloud Work worker is running."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Anchored result of a run that did not complete: what happened, whether
 * retrying can help, and where to fix it when it cannot.
 */
export function RunProblemNotice({
  problem,
  admin,
  disabled,
  onRetry,
  onChooseModel,
  onNewConversation,
}: {
  problem: CloudRunProblem;
  admin: boolean;
  disabled: boolean;
  onRetry: () => void;
  onChooseModel: () => void;
  onNewConversation?: () => void;
}) {
  if (problem.compact) {
    return (
      <div role="status" className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{problem.title}</span>
        {problem.retry && (
          <button type="button" disabled={disabled} onClick={onRetry}
            className="min-h-9 rounded-sm px-1 font-medium underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline motion-reduce:transition-none">
            Try again
          </button>
        )}
      </div>
    );
  }
  const error = problem.tone === "error";
  const Icon = error ? AlertTriangleIcon : InfoIcon;
  return (
    // Polite on purpose: a past conversation reopening on a failed run must not
    // interrupt, and the workspace already announces a fresh failure itself.
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3.5",
        error
          ? "border-destructive/25 bg-destructive-muted text-destructive-muted-foreground"
          : "border-border bg-secondary/60 text-foreground",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{problem.title}</p>
        <p
          className={cn(
            "text-sm leading-6 sm:text-xs",
            error ? "opacity-90" : "text-muted-foreground",
          )}
        >
          {problem.detail}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {problem.retry ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onRetry}
            >
              <RotateCcwIcon aria-hidden />
              Try again
            </Button>
          ) : null}
          {problem.fix === "newConversation" && onNewConversation ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onNewConversation}
            >
              <PlusIcon aria-hidden />
              Start a new conversation
            </Button>
          ) : null}
          {problem.fix === "newConversation" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onChooseModel}
            >
              <SlidersHorizontalIcon aria-hidden />
              View available models
            </Button>
          ) : null}
          {problem.fix === "models" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onChooseModel}
            >
              <SlidersHorizontalIcon aria-hidden />
              View available models
            </Button>
          ) : null}
          {problem.fix === "access" && admin ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/work">Manage Work access</Link>
            </Button>
          ) : null}
          {problem.fix === "administrator" && admin ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/work?section=providers">Manage providers</Link>
            </Button>
          ) : null}
          {problem.fix === "models" && admin ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/work?section=providers">Fix allowed models</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
