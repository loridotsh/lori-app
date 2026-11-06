"use client";

import { useId, useState } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronUpIcon, FilesIcon } from "lucide-react";
import { fileIcon, fileKind } from "../composer/file-kinds";
import { artifactDisplayName, isArtifactFile, type CloudVisual } from "@lori-enterprise/contracts";
import { visualKind } from "../visuals/kinds";

const COLLAPSED_FILES = 4;

/** Every output stays reachable directly from the response that created it. */
export function ChangedFiles({ paths, onOpen, artifactTitles, artifactVisuals }: { paths: string[]; onOpen: (path: string) => void; artifactTitles?: ReadonlyMap<string, string>; artifactVisuals?: ReadonlyMap<string, CloudVisual> }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!paths.length) return null;
  const visible = expanded ? paths : paths.slice(0, COLLAPSED_FILES);
  const remaining = paths.length - COLLAPSED_FILES;
  const Chevron = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <section aria-label="Files from this response" className="mt-4 w-full min-w-0 max-w-xl overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/20 px-3 py-2.5 text-xs text-muted-foreground">
        <FilesIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{paths.length} {paths.length === 1 ? "file" : "files"}</span>
      </div>
      <ul id={listId} className="divide-y divide-border/50 px-1">
        {visible.map((path) => {
          const artifact = isArtifactFile(path);
          const visual = artifact ? artifactVisuals?.get(path) : undefined;
          const kind = visual && visualKind(visual);
          const Icon = kind ? kind.icon : fileIcon(fileKind(path));
          const name = artifactDisplayName(path, artifactTitles?.get(path));
          const extension = artifact ? "Artifact" : name.includes(".") ? name.split(".").pop()?.toUpperCase() : "File";
          return (
            <li key={path} className="min-w-0">
              <button type="button" title={path} onClick={() => onOpen(path)}
                aria-label={artifact ? `Open ${name} in workspace` : `Open preview of ${path}`}
                className="group flex h-12 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{name}</span>
                  {artifact && <span className="block truncate text-[11px] text-muted-foreground">{[kind?.label, kind?.detail, "Open in workspace"].filter(Boolean).join(" · ")}</span>}
                </span>
                <span aria-hidden className="shrink-0 text-[11px] text-muted-foreground">{extension}</span>
                <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
      {remaining > 0 && (
        <div className="flex justify-end border-t border-border/60 px-2">
          <button type="button" aria-expanded={expanded} aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
            {expanded ? "Show less" : `Show more (${remaining})`}
            <Chevron aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
