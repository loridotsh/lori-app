import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground transition-colors placeholder:text-muted-foreground hover:border-input-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground sm:h-9 sm:text-sm",
        className,
      )}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}
