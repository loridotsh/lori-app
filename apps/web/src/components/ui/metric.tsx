import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function MetricGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid divide-y border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Metric({
  action,
  href,
  label,
  value,
}: {
  action?: string;
  href?: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-4 first:pt-0 last:pb-0 sm:px-5 sm:py-5 first:sm:py-5 first:sm:pl-0 last:sm:py-5 last:sm:pr-0">
      <p className="text-sm font-medium text-muted-foreground sm:text-xs">
        {label}
      </p>
      <p className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      {href && action ? (
        <Link
          className="mt-1 inline-flex min-h-11 w-fit items-center gap-1 text-sm font-medium text-primary hover:underline sm:min-h-0 sm:text-xs"
          href={href}
        >
          {action}
          <ArrowRightIcon className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}
