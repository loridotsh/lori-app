import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
  className,
}: {
  actions?: ReactNode;
  description: string;
  eyebrow?: ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between sm:pb-6",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? (
          <div className="text-xs font-medium text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-[1.375rem]">
          {title}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="shrink-0 pt-1 sm:pt-0">{actions}</div>
      ) : null}
    </header>
  );
}
