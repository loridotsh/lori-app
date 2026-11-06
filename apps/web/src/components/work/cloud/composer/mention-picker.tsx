"use client";

import type { CloudExtensionsSnapshot, CloudFile } from "@lori-enterprise/contracts";
import { BookOpenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CatalogLogo } from "@/components/catalog-logo";
import { cloudApi } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { formatSize } from "../cloud-files";
import { fileIcon, fileKind } from "./file-kinds";
import type { MentionOption } from "./mentions";

/**
 * Everything a message can point at: the conversation's files, and the member's
 * connected plugins and enabled skills. Plugins and skills load the first time
 * the picker is needed; if that fails, files still work and the next try retries.
 */
export function useMentionOptions(
  files: CloudFile[],
  extensionsAvailable: boolean,
  needExtensions: boolean,
  projectId?: string,
): MentionOption[] {
  const [snapshot, setSnapshot] = useState<{ scope: string | undefined; value: CloudExtensionsSnapshot } | null>(null);

  useEffect(() => {
    if (!needExtensions || !extensionsAvailable) return;
    const controller = new AbortController();
    setSnapshot(null);
    cloudApi<CloudExtensionsSnapshot>(projectId ? `/projects/${projectId}/extensions` : "/extensions", { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted && Array.isArray(value?.plugins) && Array.isArray(value?.skills)) setSnapshot({ scope: projectId, value });
      }).catch(() => { if (!controller.signal.aborted) setSnapshot(null); });
    return () => controller.abort();
  }, [needExtensions, extensionsAvailable, projectId]);
  return useMemo(() => {
    const current = snapshot?.scope === projectId ? snapshot?.value : null;
    const options: MentionOption[] = files
      // Trash holds files the assistant moved aside; they are not something to point at.
      .filter((file) => !file.path.startsWith("Trash/"))
      .map((file) => ({ id: `file:${file.id}`, kind: "file", label: file.path, detail: formatSize(file.sizeBytes) }));
    for (const plugin of (extensionsAvailable ? current?.plugins : []) ?? [])
      if (plugin.allowed && plugin.connection?.status === "connected" && plugin.connection.enabled)
        options.push({ id: `plugin:${plugin.id}`, kind: "plugin", label: plugin.name, pluginId: plugin.id });
    for (const skill of (extensionsAvailable ? current?.skills : []) ?? [])
      if (skill.allowed && skill.enabled)
        options.push({ id: `skill:${skill.id}`, kind: "skill", label: skill.name, detail: skill.description });
    return options;
  }, [files, snapshot, extensionsAvailable, projectId]);
}

const KIND_LABEL = { file: "File", plugin: "Plugin", skill: "Skill" } as const;

export function MentionPicker({
  listboxId,
  options,
  activeIndex,
  empty,
  onPick,
  onHover,
}: {
  listboxId: string;
  options: MentionOption[];
  activeIndex: number;
  /** Shown when nothing matches. */
  empty: string;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = list.current, row = container?.children[activeIndex] as HTMLElement | undefined;
    if (!container || !row) return;
    if (row.offsetTop < container.scrollTop) container.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = row.offsetTop + row.offsetHeight - container.clientHeight;
  }, [activeIndex, options]);
  return (
    <div className="absolute inset-x-2 bottom-full z-20 mb-2 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      {options.length ? (
        <div
          ref={list}
          role="listbox"
          id={listboxId}
          aria-label="Mention a file, plugin or skill"
          className="relative max-h-64 overflow-x-hidden overflow-y-auto"
        >
          {options.map((option, index) => {
            const Icon = option.kind === "file" ? fileIcon(fileKind(option.label)) : BookOpenIcon;
            return (
              <div
                key={option.id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Keep focus in the message box while choosing.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(option);
                }}
                onMouseMove={() => onHover(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]",
                  index === activeIndex && "bg-secondary",
                )}
              >
                {option.kind === "plugin" && option.pluginId ? (
                  <CatalogLogo id={option.pluginId} type="plugin" size="sm" />
                ) : (
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {option.kind === "file" ? option.detail : KIND_LABEL[option.kind]}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p role="status" id={listboxId} className="px-3 py-2 text-xs text-muted-foreground">
          {empty}
        </p>
      )}
    </div>
  );
}
