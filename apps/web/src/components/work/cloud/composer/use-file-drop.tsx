"use client";

import { UploadCloudIcon } from "lucide-react";
import { useCallback, useRef, useState, type DragEvent } from "react";

const carriesFiles = (event: DragEvent) =>
  [...(event.dataTransfer?.types ?? [])].includes("Files");

/** Files from a drop, plus how many folders were skipped (browsers cannot upload a folder as one file). */
export function filesFromDrop(transfer: DataTransfer): { files: File[]; folders: number } {
  const files: File[] = [];
  let folders = 0;
  const items = [...(transfer.items ?? [])].filter((item) => item.kind === "file");
  if (items.length) {
    for (const item of items) {
      const entry =
        "webkitGetAsEntry" in item && typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null;
      if (entry?.isDirectory) {
        folders++;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return { files, folders };
  }
  return { files: [...(transfer.files ?? [])], folders };
}

/**
 * Drag-and-drop for a region. Every file drag is cancelled so the browser never
 * navigates to a dropped file, even when adding files is not possible right now;
 * `blocked` then explains why instead of the drop doing nothing.
 */
export function useFileDrop({
  blocked,
  onFiles,
}: {
  /** A reason files cannot be added right now, or null when they can. */
  blocked: string | null;
  onFiles: (files: File[], info: { folders: number }) => void;
}) {
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for every child element crossed; count them.
  const depth = useRef(0);
  const end = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);
  const bind = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? "none" : "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const transfer = event.dataTransfer;
      end();
      if (blocked || !transfer) return;
      const { files, folders } = filesFromDrop(transfer);
      if (files.length || folders) onFiles(files, { folders });
    },
  };
  return { dragging, blocked, bind };
}

export function DropOverlay({ blocked }: { blocked: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-background/90 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        <UploadCloudIcon aria-hidden className="size-8 text-primary" strokeWidth={1.5} />
        <p className="text-sm font-medium">
          {blocked ? "Files can’t be added right now" : "Drop files to attach"}
        </p>
        <p className="max-w-xs text-xs leading-5 text-muted-foreground">
          {blocked ?? "They’re saved in this conversation’s files, up to 20 MB each."}
        </p>
      </div>
    </div>
  );
}
