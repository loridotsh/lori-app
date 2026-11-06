"use client";

import type { CloudFile } from "@lori-enterprise/contracts";
import { UploadIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSize } from "../cloud-files";
import { ShimmerText } from "../shimmer-text";
import { fileIcon, fileKind } from "./file-kinds";

export interface UploadProgress {
  done: number;
  total: number;
  name: string;
}

/** What is attached to the next message, and what is still on its way. */
export function AttachmentChips({
  attachments,
  files,
  uploading,
  disabled,
  onRemove,
  controlClass,
}: {
  attachments: string[];
  files: CloudFile[];
  uploading: UploadProgress | null;
  disabled: boolean;
  onRemove: (id: string) => void;
  controlClass: string;
}) {
  if (!attachments.length && !uploading) return null;
  return (
    <ul
      aria-label="Attached files"
      className="mb-1 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto px-1 pt-1"
    >
      {attachments.map((id) => {
        const file = files.find((item) => item.id === id);
        const Icon = fileIcon(fileKind(file?.path ?? "", file?.mimeType));
        const name = file?.path.split("/").at(-1) ?? "Attached file";
        return (
          <li
            key={id}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-[var(--work-header)] py-1 pl-2 pr-1 text-xs"
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-48 truncate" title={file?.path}>
              {name}
            </span>
            {file ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {formatSize(file.sizeBytes)}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={`Remove attachment ${file?.path ?? id}`}
              disabled={disabled}
              onClick={() => onRemove(id)}
              className={cn(controlClass, "shrink-0 p-1")}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </li>
        );
      })}
      {uploading ? (
        <li
          role="status"
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-[var(--work-header)] px-2 py-1 text-xs text-muted-foreground"
        >
          <UploadIcon aria-hidden className="size-3.5 shrink-0" />
          <ShimmerText className="max-w-56 truncate">
            Uploading {uploading.total > 1 ? `${uploading.done + 1} of ${uploading.total} · ` : ""}
            {uploading.name}
          </ShimmerText>
        </li>
      ) : null}
    </ul>
  );
}
