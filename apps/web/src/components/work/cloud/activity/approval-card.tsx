"use client";

import type { CloudApproval, CloudToolInvocation } from "@lori-enterprise/contracts";
import { ArrowUpRightIcon, LoaderCircleIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientApiError } from "@/lib/client-api";
import { cloudApi, cloudMutation } from "@/lib/cloud-work-api";
import { formatSize } from "../cloud-files";
import { fileIcon, fileKind } from "../composer/file-kinds";
import { changeDiff, DiffView, exactJson } from "./tool-output";
import { describeTool, pluginName } from "./tool-presentation";

type Rec = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

const CODE_BLOCK =
  "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-secondary/60 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]";
const DISCLOSURE =
  "w-fit cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function title(invocation: CloudToolInvocation, approval: CloudApproval): string {
  if (approval.kind === "apply_files") return "Apply generated files?";
  switch (describeTool(invocation).kind) {
    case "command":
      return "Allow this command?";
    case "write":
      return "Apply this change?";
    case "files":
      return "Allow this file change?";
    case "plugin":
      return `Allow this action in ${pluginName(str(invocation.arguments.pluginId)) || "the plugin"}?`;
    case "memory":
      return "Save this to memory?";
    default:
      return "Allow this action?";
  }
}

/** What the member is being asked to allow, in the form most useful to judge it. */
function Preview({ invocation }: { invocation: CloudToolInvocation }) {
  const args = (invocation.arguments ?? {}) as Rec;
  const diff = changeDiff(invocation.name, args);
  switch (invocation.name) {
    case "run_command":
      return (
        <div className="space-y-2">
          <pre className={CODE_BLOCK} tabIndex={0}>
            {str(args.command)}
          </pre>
          <p className="text-[11px] text-muted-foreground">
            Runs in this conversation’s private sandbox, with no network
            {typeof args.timeoutSeconds === "number" ? ` · stops after ${args.timeoutSeconds}s` : ""}.
          </p>
        </div>
      );
    case "write_file":
    case "edit_file":
      return (
        <div className="space-y-2">
          <p className="text-xs">
            <span className="font-medium">{str(args.path)}</span>
            <span className="text-muted-foreground">
              {invocation.name === "edit_file"
                ? " · edits part of the file"
                : args.expectedHash
                  ? " · replaces the file"
                  : " · creates a new file"}
            </span>
          </p>
          {diff ? <DiffView lines={diff} limit={60} /> : null}
        </div>
      );
    case "manage_files":
      return (
        <p className="text-xs">
          <span className="font-medium capitalize">{str(args.action) || "Change"}</span>{" "}
          {str(args.path)}
          {args.destination ? <span className="text-muted-foreground"> → {str(args.destination)}</span> : null}
          {args.action === "trash" ? (
            <span className="text-muted-foreground"> · moved to Trash, not erased</span>
          ) : null}
        </p>
      );
    case "memory_update":
      return (
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-xs font-medium">{str(args.topic)}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {str(args.content)}
          </p>
        </div>
      );
    case "call_plugin_tool":
      return (
        <div className="space-y-2">
          <p className="text-xs">
            <span className="font-medium">{str(args.name)}</span>
            <span className="text-muted-foreground"> in {pluginName(str(args.pluginId))}</span>
          </p>
          <details className="text-xs">
            <summary className={DISCLOSURE}>Inputs</summary>
            <pre className={`mt-1.5 ${CODE_BLOCK} text-[11px]`} tabIndex={0}>
              {exactJson(args.arguments)}
            </pre>
          </details>
        </div>
      );
    default:
      return (
        <details className="text-xs">
          <summary className={DISCLOSURE}>Inputs</summary>
          <pre className={`mt-1.5 ${CODE_BLOCK} text-[11px]`} tabIndex={0}>
            {exactJson(Object.fromEntries(Object.entries(args).filter(([key]) => key !== "expectedHash")))}
          </pre>
        </details>
      );
  }
}

/** Generated files waiting to be added: one quiet row each, with the evidence to judge them. */
function GeneratedFiles({
  approval,
  invocation,
}: {
  approval: CloudApproval;
  invocation: CloudToolInvocation;
}) {
  if (!approval.files?.length) return null;
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
      {approval.files.map((file) => {
        const Icon = fileIcon(fileKind(file.path));
        return (
          <li key={file.path} className="px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="break-all text-[13px] font-medium leading-5">{file.path}</p>
                <p className="text-[11px] text-muted-foreground">
                  {file.expectedHash ? "Replaces the existing file" : "Adds a new file"} · {formatSize(file.sizeBytes)}
                </p>
              </div>
              <a
                href={`/api/v1/work/cloud/runs/${encodeURIComponent(approval.runId)}/tools/${encodeURIComponent(invocation.id)}/outputs?path=${encodeURIComponent(file.path)}`}
                download
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                Review file
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </div>
            <details className="mt-1.5 pl-7 text-[11px] text-muted-foreground">
              <summary className={DISCLOSURE}>File versions</summary>
              <p className="mt-1 break-all font-mono">Proposed: {file.sha256}</p>
              {file.expectedHash && <p className="mt-1 break-all font-mono">Current: {file.expectedHash}</p>}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function ApprovalCard({
  invocation,
  approval,
  onChanged,
  onFailure,
}: {
  invocation: CloudToolInvocation;
  approval: CloudApproval;
  onChanged: () => Promise<void>;
  onFailure: (failure: unknown) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const inFlight = useRef(false);
  // A lost reply is retried with the same request so a decision is never applied twice.
  const [pending, setPending] = useState<{
    requestId: string;
    actionHash: string;
    decision: "approve" | "deny";
  } | null>(null);
  const apply = approval.kind === "apply_files";
  const decide = async (decision: "approve" | "deny") => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = pending ?? {
      requestId: crypto.randomUUID(),
      actionHash: approval.actionHash,
      decision,
    };
    setBusy(request.decision);
    try {
      await cloudApi(
        `/runs/${encodeURIComponent(approval.runId)}/approvals/${encodeURIComponent(approval.id)}`,
        cloudMutation(request),
      );
      setPending(null);
      await onChanged();
    } catch (failure) {
      if (
        !(failure instanceof ClientApiError) ||
        failure.status === 0 ||
        failure.status >= 500
      )
        setPending(request);
      else setPending(null);
      onFailure(failure);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const writes = describeTool(invocation).kind === "write";
  const plugin = describeTool(invocation).kind === "plugin";
  // The preview already shows what will happen; a description is added only where it says more.
  const description = apply
    ? "Review the proposed files before adding them to this conversation. Existing files are replaced only when their reviewed version still matches."
    : plugin
      ? approval.summary
      : null;
  const working = busy !== null;
  return (
    <section
      aria-label="Approval needed"
      aria-busy={working}
      className="mt-2 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="space-y-3 p-4">
        <div>
          <p className="text-sm font-medium">{title(invocation, approval)}</p>
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {apply ? <GeneratedFiles approval={approval} invocation={invocation} /> : <Preview invocation={invocation} />}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-secondary/30 px-3 py-2.5">
        {pending ? (
          <>
            <p className="mr-auto text-xs text-muted-foreground">
              Your decision may have been received. Check the saved decision with the same request.
            </p>
            <Button size="sm" disabled={working} onClick={() => void decide(pending.decision)}>
              {working ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
              Check saved decision
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => void decide("deny")}>
              {busy === "deny" ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
              {apply ? "Reject" : "Deny"}
            </Button>
            <Button size="sm" disabled={working} onClick={() => void decide("approve")}>
              {busy === "approve" ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
              {apply ? "Apply files" : writes ? "Apply change" : "Allow once"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
