"use client";

import type { CloudApproval, CloudToolInvocation } from "@lori-enterprise/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { ShimmerText } from "../shimmer-text";
import { ToolRow } from "./tool-row";
import { ApprovalCard } from "./approval-card";
import { describeTool, summarizeActivity } from "./tool-presentation";
import { clock, stageLabel, useElapsed } from "./use-elapsed";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Consecutive tool calls under one disclosure. Collapsed, it says what is
 * happening now or what was done. Results stay collapsed; pending decisions
 * remain visible outside the disclosure so they cannot be hidden accidentally.
 */
export function ToolGroup({
  invocations,
  approvals,
  onChanged,
  onFailure,
}: {
  invocations: CloudToolInvocation[];
  approvals: CloudApproval[];
  onChanged: () => Promise<void>;
  onFailure: (failure: unknown) => void;
}) {
  const [manual, setManual] = useState(false);
  const panelId = useId();
  const waiting = invocations.find(
    (item) =>
      item.status === "pendingApproval" &&
      approvals.some((a) => a.invocationId === item.id && a.status === "pending"),
  );
  const live = [...invocations]
    .reverse()
    .find((item) => item.status === "running" || item.status === "pendingExecution");
  const liveElapsed = useElapsed(live?.updatedAt, !!live);
  const failed = invocations.filter((item) => item.status === "failed").length;
  const unknown = invocations.filter((item) => item.status === "unknown").length;
  const open = manual;
  const state = waiting ? "attention" : live ? "working" : "done";
  const decisions = approvals.filter((approval) => approval.status === "pending" &&
    invocations.some((item) => item.id === approval.invocationId && item.status === "pendingApproval"));
  const cards = decisions.map((approval) => (
    <ApprovalCard key={approval.id}
      invocation={invocations.find((item) => item.id === approval.invocationId)!}
      approval={approval} onChanged={onChanged} onFailure={onFailure} />
  ));

  // One call needs no group around it: the row already says what happened.
  if (invocations.length === 1)
    return (
      <section aria-label="Tool activity" data-activity-state={state} className="space-y-2">
      <ul role="list">
        <ToolRow
          invocation={invocations[0]!}
          approvals={approvals}
          onChanged={onChanged}
          onFailure={onFailure}
        />
      </ul>
      {cards}
      </section>
    );

  let heading: string;
  if (waiting) {
    heading = `Needs your approval · ${plural(invocations.length, "tool", "tools")}`;
  } else if (live) {
    const view = describeTool(live);
    heading = `${view.active} ${view.subject}…`.trim();
  } else if (unknown) {
    heading = `${plural(unknown, "step needs", "steps need")} verification`;
  } else if (failed) {
    heading = `${failed} of ${plural(invocations.length, "step", "steps")} failed`;
  } else {
    heading = `Used ${plural(invocations.length, "tool", "tools")}`;
  }

  return (
    <section aria-label="Tool activity" data-activity-state={state}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setManual((value) => !value)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* State is written and coloured in the heading itself: no status dot. */}
        <ShimmerText
          active={state === "working"}
          className={cn(
            "min-w-0 truncate font-medium",
            state === "attention" && "text-warning-muted-foreground",
            state === "done" && (failed || unknown ? "text-destructive" : "text-muted-foreground"),
          )}
        >
          {heading}
        </ShimmerText>
        {state === "done" && !failed && !unknown ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
            {summarizeActivity(invocations)}
          </span>
        ) : null}
        {live ? (
          // Collapsed, the group still says what stage the running tool is in and for how long.
          <span aria-hidden className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
            {stageLabel(live.status, describeTool(live).kind)}
            {liveElapsed >= 2 ? ` · ${clock(liveElapsed)}` : ""}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <div id={panelId} role="region" aria-label="Tool activity details" hidden={!open}>
        {open ? (
          <ul role="list" className="mt-1 space-y-0.5 motion-safe:animate-reveal">
            {invocations.map((invocation) => (
              <ToolRow
                key={invocation.id}
                invocation={invocation}
                approvals={approvals}
                onChanged={onChanged}
                onFailure={onFailure}
              />
            ))}
          </ul>
        ) : null}
      </div>
      <div className="space-y-2">{cards}</div>
    </section>
  );
}
