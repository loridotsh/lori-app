"use client";

import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useWorkAvailability } from "@/hooks/use-work-availability";

/** Management pages belong to Settings; Work is the return destination. */
export function WorkModeSwitch({ mode }: { mode: "manage" | "work" }) {
  const available = useWorkAvailability(mode === "work");
  if (mode === "work") return null;
  const className = "inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  if (available === false) {
    return <span role="link" aria-disabled="true" tabIndex={0} className={className}
      title="Work is turned off for your account. An administrator can turn it on in Work access.">
      <ArrowLeftIcon aria-hidden className="size-4" />
      Work<span className="sr-only"> (unavailable). Work is turned off for your account.</span>
    </span>;
  }
  return <Link href="/work/cloud" className={className}><ArrowLeftIcon aria-hidden className="size-4" />Work</Link>;
}
