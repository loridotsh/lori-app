import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  action,
  className,
  description,
  icon: Icon,
  title,
}: {
  action?: ReactNode;
  className?: string;
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <Icon
        aria-hidden
        className="size-8 text-muted-foreground/60"
        strokeWidth={1.5}
      />
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground sm:text-xs">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
