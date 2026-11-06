"use client";

import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Dialog({
  children,
  className,
  contentClassName,
  description,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  description?: string;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      // Some DOM implementations expose showModal() without reflecting the
      // open attribute. Reflecting it keeps the modal visible to assistive
      // technology and makes the component deterministic in SSR/test DOMs.
      if (!dialog.hasAttribute("open")) {
        dialog.setAttribute("open", "");
      }
    } else if (!open && dialog.open) {
      dialog.close();
    } else if (!open) {
      dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-hidden rounded-lg border border-border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-foreground/35 backdrop:backdrop-blur-[2px] open:flex open:flex-col open:animate-dialog-in backdrop:animate-backdrop-in",
        className,
      )}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      ref={ref}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p
              className="text-sm leading-relaxed text-muted-foreground sm:text-xs"
              id={descriptionId}
            >
              {description}
            </p>
          ) : null}
        </div>
        <Button
          aria-label="Close dialog"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div
        className={cn(
          "min-h-0 overflow-y-auto overscroll-contain px-5 py-4",
          contentClassName,
        )}
      >
        {children}
      </div>
    </dialog>
  );
}
