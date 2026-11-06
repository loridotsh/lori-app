import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-base leading-6 text-foreground transition-colors placeholder:text-muted-foreground hover:border-input-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground sm:text-sm",
        className,
      )}
      data-slot="textarea"
      {...props}
    />
  );
}
