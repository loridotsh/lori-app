import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
  action,
  children,
  className,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: string;
  title: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-xs">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  children,
  description,
  hint,
  label,
  icon,
}: {
  children: ReactNode;
  description: string;
  hint?: string;
  label: string;
  icon?: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 sm:py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-sm leading-relaxed text-muted-foreground sm:text-xs">
            {description}
          </p>
          {hint ? (
            <p className="font-mono text-xs font-medium text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
