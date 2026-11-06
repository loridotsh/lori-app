"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircleIcon, ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/section";

export function WorkLoadError({
  status,
  backHref = "/work",
  backLabel = "Work overview",
}: {
  status: number;
  backHref?: string;
  backLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [retried, setRetried] = useState(false);
  const forbidden = status === 403;
  const missing = status === 404;
  const title = forbidden
    ? "You don’t have access to these settings"
    : missing
      ? "This access policy is no longer available"
      : status === 429
        ? "Too many requests"
        : "Work settings couldn’t load";
  const description = forbidden
    ? "Your organization or team role may have changed. You can still check your own Work access."
    : missing
      ? "The member or team may have been removed. Return to Work to choose another scope."
      : status === 429
        ? "Wait a moment, then try again. No changes were made."
        : "Check your connection and try again. Your organization’s settings have not been changed.";
  return (
    <Panel>
      <div role="alert" className="flex flex-col gap-4 p-5 sm:flex-row sm:p-6">
        <AlertCircleIcon
          className="size-5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
          {retried && !pending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Still unavailable? Ask an administrator to check your access or
              the Enterprise service.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-2">
            {!forbidden && !missing ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setRetried(true);
                  startTransition(() => router.refresh());
                }}
              >
                <RefreshCwIcon
                  className={
                    pending
                      ? "animate-spin motion-reduce:animate-none"
                      : undefined
                  }
                />
                {pending ? "Checking…" : "Try again"}
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href={backHref}>
                <ArrowLeftIcon />
                {backLabel}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
