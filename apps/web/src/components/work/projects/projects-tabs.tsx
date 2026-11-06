"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface ProjectsTab<Id extends string> {
  id: Id;
  label: string;
  unsaved?: boolean;
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

export function ProjectsTabs<Id extends string>({ base, label, tabs, value, onChange }: { base: string; label: string; tabs: ProjectsTab<Id>[]; value: Id; onChange: (id: Id) => void }) {
  const refs = useRef<Map<Id, HTMLButtonElement>>(new Map());
  const move = (event: KeyboardEvent, from: number) => {
    const next = event.key === "ArrowRight" ? from + 1 : event.key === "ArrowLeft" ? from - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => { if (node) refs.current.set(tab.id, node); else refs.current.delete(tab.id); }}
          type="button"
          role="tab"
          id={tabId(base, tab.id)}
          aria-selected={value === tab.id}
          aria-controls={panelId(base, tab.id)}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => move(event, index)}
          className={cn("-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", value === tab.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {tab.label}
          {tab.unsaved && (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              <span className="sr-only">(unsaved changes)</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
