import type { CloudRunStatus } from "@lori-enterprise/contracts";
import { CircleAlertIcon, Clock3Icon, LoaderCircleIcon, ShieldQuestionIcon } from "lucide-react";

/** A quiet, fixed-size marker: idle history does not need a badge. */
export function ConversationStatus({ status }: { status?: CloudRunStatus | null }) {
  const state = status === "queued" ? { label: "Queued", Icon: Clock3Icon }
    : status === "running" ? { label: "Agent running", Icon: LoaderCircleIcon }
    : status === "awaitingApproval" ? { label: "Waiting for approval", Icon: ShieldQuestionIcon }
    : status === "failed" || status === "interrupted" ? { label: status === "failed" ? "Run failed" : "Run interrupted", Icon: CircleAlertIcon }
    : null;
  return <span className="flex size-4 shrink-0 items-center justify-center" title={state?.label}>
    {state && <><state.Icon aria-hidden className={`size-3.5 ${status === "running" ? "motion-safe:animate-spin" : ""}`} /><span className="sr-only">{state.label}</span></>}
  </span>;
}
