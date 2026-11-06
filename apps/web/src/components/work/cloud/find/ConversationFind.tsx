"use client";

import { ArrowDown, ArrowUp, LoaderCircle, Search, X } from "lucide-react";
import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ConversationFind } from "./useConversationFind";

// Keep highlight styling scoped to message content, using the host's theme tokens.
export const findHighlightClasses = "[&_*::highlight(work-find)]:bg-warning/30 [&_*::highlight(work-find-current)]:bg-foreground [&_*::highlight(work-find-current)]:text-background";
const iconButton = "flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none enabled:hover:bg-secondary enabled:hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-muted-foreground disabled:opacity-35 forced-colors:focus-visible:[outline:2px_solid_Highlight]";

export function ConversationFindToggle({ find }: { find: ConversationFind }) {
  return <button ref={find.trigger} type="button" aria-label="Find in this conversation" title="Find in this conversation · ⌘/Ctrl F" aria-expanded={find.active} onClick={find.active ? find.close : find.show} className={iconButton}><Search size={14} aria-hidden /></button>;
}

export function ConversationFindBar({ find }: { find: ConversationFind }) {
  if (!find.active) return null;
  const status = !find.query.trim() ? "" : find.limited ? "Many matches. Refine your search."
    : find.historyError ? "Could not finish searching earlier messages."
    : find.paused ? "Earlier-message search will resume when the current operation finishes."
    : find.loading ? "Searching earlier messages…" : "";
  const hasQuery = !!find.query.trim();
  const noMatches = hasQuery && !find.scanning && !find.count && !find.incomplete;
  const count = !hasQuery || find.scanning ? "" : noMatches ? "No matches" : `${find.position}/${find.count.toLocaleString()}${find.limited || find.incomplete ? "+" : ""}`;
  const announcement = find.scanning ? "Searching messages" : noMatches ? "No matches in this conversation" : hasQuery
    ? `${find.position} of ${find.count} matches${find.incomplete ? ", earlier history incomplete" : ""}${find.current ? `. ${find.current.excerpt}` : ""}` : "";
  return <div role="search" aria-label="Find in conversation"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); find.close(); } }}
    className="absolute end-3 top-2 z-20 w-80 max-w-[calc(100%_-_1.5rem)] rounded-md border border-border bg-background p-1 text-[13px] text-foreground transition-colors focus-within:border-muted-foreground motion-safe:animate-reveal forced-colors:focus-within:[outline:1px_solid_Highlight]">
    <div className="flex min-w-0 items-center gap-0.5">
      <Search size={13} aria-hidden className="mx-1 shrink-0 text-muted-foreground" />
      <input ref={find.input} type="text" inputMode="search" dir="auto" autoComplete="off" spellCheck={false} maxLength={256}
        aria-label="Search messages" placeholder="Find in conversation" value={find.query}
        onChange={event => find.changeQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); find.move(event.shiftKey ? -1 : 1); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); find.close(); }
        }}
        className="h-7 w-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-base shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0 sm:text-[13px]" />
      <span role="status" aria-live="polite" aria-atomic="true" aria-label={announcement || undefined}
        className="flex min-w-6 shrink-0 items-center justify-center whitespace-nowrap px-1 text-[11px] tabular-nums text-muted-foreground">
        {find.scanning ? <LoaderCircle size={12} aria-hidden className="motion-safe:animate-spin" /> : count}
      </span>
      <button type="button" className={iconButton} aria-label="Previous match" title="Previous match · Shift Enter" disabled={!find.count} onClick={() => find.move(-1)}><ArrowUp size={13} aria-hidden /></button>
      <button type="button" className={iconButton} aria-label="Next match" title="Next match · Enter" disabled={!find.count} onClick={() => find.move(1)}><ArrowDown size={13} aria-hidden /></button>
      <button type="button" className={iconButton} aria-label="Close conversation search" title="Close · Escape" onClick={find.close}><X size={14} aria-hidden /></button>
    </div>
    {status && <div className="flex items-start gap-1.5 px-1 pb-1 pt-1.5 text-[11px] leading-4 text-muted-foreground" role="status">
      {find.loading && <LoaderCircle size={11} aria-hidden className="mt-0.5 shrink-0 motion-safe:animate-spin" />}
      <span className="min-w-0 flex-1">{status}</span>
      {find.historyError && <button type="button" className="shrink-0 rounded underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground" onClick={find.retryHistory}>Retry</button>}
    </div>}
  </div>;
}

interface Rect { left: number; top: number; width: number; height: number; active: boolean }
/** Older WebViews get a non-interactive overlay; neither path rewrites message DOM. */
export function ConversationFindHighlights({ find, viewport }: { find: ConversationFind; viewport: RefObject<HTMLDivElement | null> }) {
  const [rects, setRects] = useState<Rect[]>([]);
  useLayoutEffect(() => {
    if (!find.searching || !viewport.current) { setRects([]); return; }
    if (typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights) {
      const all = new Highlight(), current = new Highlight();
      for (const match of find.matches) all.add(match.range);
      if (find.current) current.add(find.current.range);
      current.priority = 1;
      CSS.highlights.set("work-find", all); CSS.highlights.set("work-find-current", current);
      setRects([]);
      return () => {
        if (CSS.highlights.get("work-find") === all) CSS.highlights.delete("work-find");
        if (CSS.highlights.get("work-find-current") === current) CSS.highlights.delete("work-find-current");
      };
    }
    const element = viewport.current;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const bounds = element.getBoundingClientRect(), next: Rect[] = [];
      for (const match of find.matches) {
        const root = match.root.getBoundingClientRect();
        if (root.bottom < bounds.top || root.top > bounds.bottom) continue;
        for (const rect of match.range.getClientRects()) {
          let left = Math.max(bounds.left, rect.left), right = Math.min(bounds.right, rect.right);
          let top = Math.max(bounds.top, rect.top), bottom = Math.min(bounds.bottom, rect.bottom);
          for (let parent = match.range.startContainer.parentElement; parent && parent !== element; parent = parent.parentElement) {
            const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
          }
          if (right > left && bottom > top) next.push({ left, top, width: right - left, height: bottom - top, active: match.key === find.current?.key });
        }
      }
      setRects(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    schedule();
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); observer?.disconnect(); };
  }, [find.searching, find.matches, find.current, viewport]);
  return rects.length ? createPortal(<div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">{rects.map((rect, index) => <span key={index} className={`absolute bg-[Highlight]/25 ${rect.active ? "ring-2 ring-[Highlight]" : ""}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}</div>, document.body) : null;
}
