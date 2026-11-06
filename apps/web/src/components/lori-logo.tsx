import { cn } from "@/lib/utils";

export function LoriLogo({
  className,
  compact = false,
  label = "Lori Enterprise",
}: {
  className?: string;
  /** Mark only, for collapsed navigation. The product name stays available to assistive technology. */
  compact?: boolean;
  label?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        aria-hidden="true"
        className="size-[1.35rem] fill-primary"
        viewBox="0 0 102 102"
      >
        <rect x="36" y="0" width="30" height="30" rx="5.5" />
        <rect x="0" y="18" width="30" height="30" rx="5.5" />
        <rect x="72" y="18" width="30" height="30" rx="5.5" />
        <rect x="36" y="36" width="30" height="30" rx="5.5" />
        <rect x="0" y="54" width="30" height="30" rx="5.5" />
        <rect x="72" y="54" width="30" height="30" rx="5.5" />
        <rect x="36" y="72" width="30" height="30" rx="5.5" />
      </svg>
      <span
        className={cn(
          "text-[0.95rem] font-semibold tracking-tight text-foreground",
          compact && "sr-only",
        )}
      >
        {label}
      </span>
    </span>
  );
}
