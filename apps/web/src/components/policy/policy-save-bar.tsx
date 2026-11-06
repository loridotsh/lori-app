import { SaveIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PolicySaveBar({
  children,
  description,
  hasChanges,
  label,
  onSave,
  pending,
  saveLabel = "Save changes",
  stickyOnMobile = true,
  saveDisabled = false,
}: {
  children?: ReactNode;
  description: string;
  hasChanges: boolean;
  label: string;
  onSave: () => void;
  pending: boolean;
  saveLabel?: string;
  stickyOnMobile?: boolean;
  saveDisabled?: boolean;
}) {
  const statusLabel = pending
    ? "Saving…"
    : hasChanges
      ? "Unsaved changes"
      : "All changes saved";

  return (
    <div className={cn(stickyOnMobile ? "sticky bottom-0" : "relative sm:sticky sm:bottom-0", "z-10 -mx-4 border-t border-border bg-background/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 [@media(max-height:480px)]:static")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "mt-2 size-2 shrink-0 rounded-full transition-colors",
              pending
                ? "bg-primary/60"
                : hasChanges
                  ? "bg-primary"
                  : "bg-muted-foreground/35",
            )}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <span
                aria-live="polite"
                className={cn(
                  "text-xs font-medium",
                  pending
                    ? "text-muted-foreground"
                    : hasChanges
                      ? "text-primary"
                      : "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">
          {children}
          <Button
            aria-disabled={pending || !hasChanges || saveDisabled}
            disabled={pending || !hasChanges || saveDisabled}
            onClick={onSave}
            size="sm"
            type="button"
          >
            <SaveIcon className="size-3.5" />
            {pending ? "Saving…" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
