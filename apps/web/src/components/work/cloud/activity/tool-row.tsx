"use client";

import type {
  CloudApproval,
  CloudToolInvocation,
} from "@lori-enterprise/contracts";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { CatalogLogo } from "@/components/catalog-logo";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { ShimmerText } from "../shimmer-text";
import { GenericResult, ToolResult } from "./tool-output";
import { clock, stageLabel, useElapsed } from "./use-elapsed";
import {
  describeTool,
  formatDuration,
  statusIcon,
  statusLabel,
} from "./tool-presentation";

const TERMINAL = new Set(["completed", "failed", "denied", "unknown"]);

export function ToolRow({
  invocation,
  approvals,
  onFailure,
}: {
  invocation: CloudToolInvocation;
  /** Every approval for the run; the row picks its own. */
  approvals: CloudApproval[];
  onChanged: () => Promise<void>;
  onFailure: (failure: unknown) => void;
}) {
  const own = approvals.filter((item) => item.invocationId === invocation.id);
  const pending = own.find((item) => item.status === "pending");
  const decided = own.find((item) => item.status !== "pending");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [fullOutput, setFullOutput] = useState<unknown>(undefined);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [outputError, setOutputError] = useState("");
  const view = describeTool(invocation);
  // Once approved, a tool is queued and then running: say which, and for how long.
  const inProgress =
    invocation.status === "running" || invocation.status === "pendingExecution";
  const elapsed = useElapsed(invocation.updatedAt, inProgress);
  const stage = stageLabel(invocation.status, view.kind);
  const { Icon, shimmer, tone } = statusIcon(invocation.status, view.Icon);
  const done = TERMINAL.has(invocation.status);
  const verb = done ? view.past : view.active;
  // Waiting for a decision is the member's time, not the tool's, so no duration then.
  const duration =
    done && !own.length
      ? formatDuration(
          Date.parse(invocation.updatedAt) - Date.parse(invocation.createdAt),
        )
      : "";
  const output = fullOutput ?? invocation.output;
  const truncated =
    !!invocation.output &&
    typeof invocation.output === "object" &&
    "truncated" in invocation.output &&
    invocation.output.truncated === true &&
    fullOutput === undefined;
  const showsInputs =
    view.kind === "plugin" ||
    view.kind === "discovery" ||
    view.kind === "skill" ||
    view.kind === "document" ||
    view.kind === "other";
  return (
    <li
      data-tool-kind={view.kind}
      data-tool-status={invocation.status}
      className="text-[13px]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${verb} ${view.subject}, ${statusLabel[invocation.status]}`.replace(
          /\s+,/,
          ",",
        )}
        onClick={() => setOpen((value) => !value)}
        className="group/row flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center",
            tone === "warning" && "text-warning-muted-foreground",
            tone === "error" && "text-destructive",
            tone === "default" && "text-muted-foreground",
          )}
        >
          {view.plugin && invocation.status === "completed" ? (
            <CatalogLogo id={view.plugin} type="plugin" size="xs" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </span>
        {/* One content-width phrase, so a running tool shimmers as a single sweep over its words. */}
        <ShimmerText active={shimmer} className="block min-w-0 truncate">
          <span
            className={cn(
              !shimmer && "text-muted-foreground",
              view.subject && "mr-2",
            )}
          >
            {verb}
          </span>
          {view.subject ? (
            <span
              className={view.kind === "command" ? "font-mono text-xs" : undefined}
              title={view.subject}
            >
              {view.subject}
            </span>
          ) : null}
        </ShimmerText>
        <span className="flex-1" />
        {pending ||
        ["failed", "denied", "unknown"].includes(invocation.status) ? (
          <span
            className={cn(
              "shrink-0 text-[11px]",
              pending ? "text-warning-muted-foreground" : "text-destructive",
            )}
          >
            {statusLabel[invocation.status]}
          </span>
        ) : decided && !(view.kind === "memory" && decided.decisionSource === "automatic") ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-[11px]",
              decided.status === "approved"
                ? "text-muted-foreground"
                : "text-destructive",
            )}
          >
            <ShieldCheckIcon aria-hidden className="size-3" />
            {decided.status === "approved"
              ? decided.decisionSource === "automatic" ? "Auto-approved" : "Approved"
              : decided.status === "denied"
                ? "Declined"
                : "Expired"}
          </span>
        ) : null}
        {duration ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {inProgress ? (
        <p className="ml-[1.375rem] flex items-center gap-1.5 pb-0.5 text-xs text-muted-foreground">
          <span>{stage}</span>
          {elapsed >= 2 ? (
            <>
              <span aria-hidden>·</span>
              <span aria-hidden className="tabular-nums">{clock(elapsed)}</span>
            </>
          ) : null}
        </p>
      ) : null}
      <div
        id={panelId}
        role="region"
        aria-label={`${verb} ${view.subject}`.trim()}
        hidden={!open}
      >
        {open ? (
          <div className="ml-[1.375rem] mt-1.5 space-y-3 border-l border-border pb-1 pl-4 motion-safe:animate-reveal">
            {!pending && output === undefined ? (
              <p role="status" className="text-xs text-muted-foreground">
                {invocation.status === "running"
                  ? "Working on it…"
                  : invocation.status === "pendingExecution"
                    ? "Waiting for the worker to pick this up…"
                    : invocation.status === "denied"
                      ? decided?.status === "expired"
                        ? "No decision was made in time, so this was not run."
                        : "You declined this, so it was not run."
                      : "No result was returned."}
              </p>
            ) : null}
            {output !== undefined &&
            !(pending && invocation.status === "pendingApproval") ? (
              <ToolResult invocation={invocation} output={output} />
            ) : null}
            {!pending &&
            showsInputs &&
            Object.keys(invocation.arguments ?? {}).length ? (
              <details className="text-xs">
                <summary className="w-fit cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Inputs
                </summary>
                <div className="mt-1.5">
                  <GenericResult
                    inputs
                    output={Object.fromEntries(
                      Object.entries(invocation.arguments).filter(
                        ([key]) =>
                          key !== "expectedHash" && key !== "schemaHash",
                      ),
                    )}
                  />
                </div>
              </details>
            ) : null}
            {!!invocation.execution?.inputs.length && (
              <details className="text-xs">
                <summary className="w-fit cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Input files captured for this action
                </summary>
                <ul className="mt-2 space-y-2">
                  {invocation.execution.inputs.map((file) => (
                    <li key={file.path}>
                      <p className="break-all">{file.path}</p>
                      <p className="mt-0.5 break-all text-[11px] text-muted-foreground">
                        {file.sha256}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {truncated ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingOutput}
                onClick={async () => {
                  setLoadingOutput(true);
                  setOutputError("");
                  try {
                    const result = await cloudApi<{ fullOutput: unknown }>(
                      `/runs/${encodeURIComponent(invocation.runId)}/tools/${encodeURIComponent(invocation.id)}`,
                    );
                    setFullOutput(result.fullOutput);
                  } catch (failure) {
                    setOutputError(cloudError(failure));
                    onFailure(failure);
                  } finally {
                    setLoadingOutput(false);
                  }
                }}
              >
                {loadingOutput ? "Loading result…" : "View complete result"}
              </Button>
            ) : null}
            {outputError ? (
              <p role="alert" className="text-xs text-destructive">
                {outputError}
              </p>
            ) : null}
            {invocation.status === "unknown" ? (
              <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <CircleAlertIcon
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0"
                />
                This action may have finished. Check the files or service before
                requesting it again.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
