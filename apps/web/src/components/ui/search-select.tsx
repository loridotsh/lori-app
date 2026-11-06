"use client";

import * as Popover from "@radix-ui/react-popover";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SearchSelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}
function adjacentControl(trigger: HTMLElement, popup: HTMLElement | null, backwards: boolean) {
  const root = trigger.closest("dialog[open]") ?? document;
  const candidates = [...root.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[tabindex]")].filter(element => {
    if (element.tabIndex < 0 || element.matches(":disabled,[data-radix-focus-guard]") || popup?.contains(element) || element.closest("[inert],[hidden],dialog:not([open])")) return false;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
  const index = candidates.indexOf(trigger);
  return index < 0 ? undefined : candidates[index + (backwards ? -1 : 1)];
}
export function SearchSelect({ label, placeholder = "Choose an option", searchPlaceholder = "Search…", value, options, onChange, disabled = false, className }: {
  label: string; placeholder?: string; searchPlaceholder?: string; value: string; options: readonly SearchSelectOption[];
  onChange: (value: string) => void; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), tabExit = useRef(false);
  const id = useId(), listId = `${id}-options`, valueId = `${id}-value`;
  const selected = options.find(option => option.value === value);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => words.every(word => `${option.label} ${option.description ?? ""} ${option.group ?? ""}`.toLocaleLowerCase().includes(word)));
  }, [options, query]);
  const activeOption = filtered[active];
  const changeOpen = (next: boolean) => {
    if (disabled && next) return;
    setOpen(next); setQuery("");
    setActive(next ? options.findIndex(option => option.value === value && !option.disabled) : -1);
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open || !trigger.current) return;
    const unavailable = () => {
      const element = trigger.current;
      if (!element || element.closest("[inert],[hidden],dialog:not([open])")) { setOpen(false); return; }
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") { setOpen(false); return; }
      }
    };
    // Portalled choices must disappear when a permission or connectivity lock
    // hides their owning form, even though the portal itself lives in body.
    const observer = new MutationObserver(unavailable);
    for (let parent: HTMLElement | null = trigger.current; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ["inert", "hidden", "style", "class", "open"] });
    unavailable();
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (!open || active < 0) return;
    const viewport = list.current;
    const option = viewport?.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
    if (!viewport || !option) return;
    // scrollIntoView also scrolls the document and any owning form. Only move
    // this list so selecting/hovering an option cannot jump the page.
    const bounds = viewport.getBoundingClientRect(), row = option.getBoundingClientRect();
    if (row.top < bounds.top) viewport.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) viewport.scrollTop += row.bottom - bounds.bottom;
  }, [active, open, filtered]);
  const choose = (option: SearchSelectOption) => { if (disabled || option.disabled) return; onChange(option.value); changeOpen(false); };
  const move = (direction: number) => {
    const enabled = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) { setActive(-1); return; }
    const position = enabled.indexOf(active);
    setActive(enabled[(position < 0 ? direction > 0 ? 0 : enabled.length - 1 : (position + direction + enabled.length) % enabled.length)]!);
  };
  return <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><button ref={trigger} type="button" role="combobox" aria-label={label} aria-describedby={valueId} aria-expanded={open && !disabled} aria-haspopup="listbox" aria-controls={open ? listId : undefined} disabled={disabled}
      onKeyDown={event => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault(); changeOpen(true);
          if (!options.some(option => option.value === value && !option.disabled)) {
            const indices = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
            setActive((event.key === "ArrowDown" ? indices[0] : indices.at(-1)) ?? -1);
          }
        }
      }}
      className={cn("flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm outline-none transition-colors hover:border-border-strong data-[state=open]:border-border-strong focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:py-1.5", className)}>
      <span id={valueId} className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")} title={selected ? `${selected.label}${selected.description ? ` · ${selected.description}` : ""}` : undefined}>{selected?.label ?? placeholder}</span><ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} align="start" sideOffset={5} collisionPadding={12} hideWhenDetached aria-label={`${label} choices`}
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => { if (tabExit.current) { event.preventDefault(); tabExit.current = false; } }}
      className="z-[70] flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[min(var(--radix-popover-trigger-width),24rem)] min-w-[min(16rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md origin-(--radix-popover-content-transform-origin) data-[state=open]:animate-menu-in data-[state=closed]:animate-menu-out">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3"><SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><input ref={input} role="combobox" aria-label={`Search ${label.toLocaleLowerCase()}`} aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeOption && !activeOption.disabled ? `${id}-option-${active}` : undefined}
        value={query} placeholder={searchPlaceholder} autoComplete="off" spellCheck={false}
        onChange={event => { setQuery(event.target.value); setActive(-1); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
          if (event.key === "Enter") { event.preventDefault(); const option = activeOption && !activeOption.disabled ? activeOption : filtered.find(item => !item.disabled); if (option) choose(option); }
          if (event.key === "Tab" && trigger.current) {
            const next = adjacentControl(trigger.current, content.current, event.shiftKey);
            tabExit.current = true; setOpen(false);
            if (next) { event.preventDefault(); next.focus(); }
            else trigger.current.focus();
          }
        }} className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:h-10 sm:text-sm" /></div>
      <div id={listId} ref={list} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]">
        {filtered.map((option, index) => <div key={option.value}>
          {option.group && option.group !== filtered[index - 1]?.group && <p role="presentation" className="px-2 py-2 text-[11px] font-medium text-muted-foreground">{option.group}</p>}
          <div id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-option-index={index} title={`${option.label}${option.description ? ` · ${option.description}` : ""}`}
            onPointerMove={() => { if (!option.disabled) setActive(index); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}
            className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm sm:min-h-9", option.disabled ? "cursor-not-allowed opacity-50" : active === index ? "bg-secondary text-foreground" : "hover:bg-secondary/60")}>
            <span className="min-w-0 flex-1"><span className="block truncate">{option.label}</span>{option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}</span>{option.value === value && <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />}
          </div>
        </div>)}
        {!filtered.length && <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">No matching options.</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
