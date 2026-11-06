import { cn } from "@/lib/utils";

export function Toggle({
  "aria-label": ariaLabel,
  checked,
  onChange,
  disabled,
}: {
  "aria-label"?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className="group inline-flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55 sm:size-9"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked
            ? "border-primary bg-primary"
            : "border-input bg-secondary group-hover:border-input-hover",
        )}
      >
        <span
          className={cn(
            "inline-block size-3.5 rounded-full bg-card shadow-sm transition-transform duration-150",
            checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
