import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Select({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "flex h-11 w-full appearance-none rounded-md border border-input bg-card pl-3 pr-8 text-base text-foreground transition-colors hover:border-input-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground sm:h-9 sm:text-sm",
        "bg-[length:1rem] bg-[right_0.5rem_center] bg-no-repeat",
        className,
      )}
      data-slot="select"
      {...props}
    />
  );
}

export function SelectWrapper({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("relative", className)}>
      {children}
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
