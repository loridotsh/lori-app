"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Play, StickyNote, X } from "lucide-react";
import type { SlidesBlock } from "@lori-enterprise/contracts";
import { SlideCanvas } from "./SlideCanvas";
import { visualButton, visualIconButton } from "./ui";

function Presenter({ block, start, onClose }: { block: SlidesBlock; start: number; onClose: (index: number) => void }) {
  const [index, setIndex] = useState(start);
  const surface = useRef<HTMLDialogElement>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const total = block.slides.length;
  useEffect(() => {
    const element = surface.current;
    if (element && !element.open) {
      try { element.showModal(); } catch { element.setAttribute("open", ""); }
      if (!element.hasAttribute("open")) element.setAttribute("open", "");
    }
    element?.focus({ preventScroll: true });
    let entered = false;
    const change = () => {
      if (document.fullscreenElement === element) entered = true;
      else if (entered) onClose(indexRef.current);
    };
    document.addEventListener("fullscreenchange", change);
    element?.requestFullscreen?.().catch(() => undefined);
    return () => {
      document.removeEventListener("fullscreenchange", change);
      if (document.fullscreenElement === element) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [onClose]);
  const go = (next: number) => setIndex(Math.max(0, Math.min(total - 1, next)));
  return createPortal(<dialog
    ref={surface}
    aria-label={`Presenting ${block.title}`}
    tabIndex={-1}
    className="group fixed inset-0 z-[1100] m-0 flex h-full max-h-none w-full max-w-none flex-col items-center justify-center border-0 bg-black p-0 outline-none backdrop:bg-black open:animate-fade-in"
    onCancel={event => { event.preventDefault(); onClose(index); }}
    onKeyDown={event => {
      if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement).closest("button")) return;
      const keys: Record<string, () => void> = {
        ArrowRight: () => go(index + 1), ArrowDown: () => go(index + 1), PageDown: () => go(index + 1), " ": () => go(index + 1), Enter: () => go(index + 1),
        ArrowLeft: () => go(index - 1), ArrowUp: () => go(index - 1), PageUp: () => go(index - 1), Backspace: () => go(index - 1),
        Home: () => go(0), End: () => go(total - 1), Escape: () => onClose(index),
      };
      const action = keys[event.key];
      if (action) { event.preventDefault(); event.stopPropagation(); action(); }
    }}
    onClick={event => { if ((event.target as HTMLElement).closest("button")) return; go(index + 1); }}
  >
    <div className="flex size-full items-center justify-center p-[2vmin] [container-type:size]">
      <div style={{ width: "min(100cqw, calc(100cqh * 16 / 9))" }}><SlideCanvas slide={block.slides[index]!} index={index} total={total} deck={block.title} /></div>
    </div>
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-xs text-white/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
      <button type="button" className="inline-flex size-8 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-30" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={16} aria-hidden /></button>
      <span className="min-w-14 text-center tabular-nums" aria-live="polite">{index + 1} / {total}</span>
      <button type="button" className="inline-flex size-8 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-30" aria-label="Next slide" disabled={index === total - 1} onClick={() => go(index + 1)}><ChevronRight size={16} aria-hidden /></button>
      <button type="button" className="ml-1 inline-flex size-8 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70" aria-label="Exit presentation" onClick={() => onClose(index)}><X size={15} aria-hidden /></button>
    </div>
  </dialog>, document.body);
}

export function VisualSlides({ block, stage = false }: { block: SlidesBlock; stage?: boolean }) {
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const presentButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const total = block.slides.length;
  const slide = block.slides[index]!;
  const go = (next: number) => setIndex(Math.max(0, Math.min(total - 1, next)));
  useEffect(() => {
    const list = rail.current;
    const thumb = list?.querySelector<HTMLElement>(`[data-slide="${index}"]`);
    if (!list || !thumb) return;
    const outer = list.getBoundingClientRect();
    const inner = thumb.getBoundingClientRect();
    if (inner.left < outer.left) list.scrollLeft -= outer.left - inner.left;
    else if (inner.right > outer.right) list.scrollLeft += inner.right - outer.right;
    if (inner.top < outer.top) list.scrollTop -= outer.top - inner.top;
    else if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom;
  }, [index]);
  const closePresenter = useRef((last: number) => { setIndex(last); setPresenting(false); requestAnimationFrame(() => presentButton.current?.focus()); }).current;

  return <div
    className={`@container/slides flex flex-col ${stage ? "h-full min-h-0" : ""}`}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest("input,textarea,select")) return;
      if (["ArrowRight", "PageDown"].includes(event.key)) { event.preventDefault(); go(index + 1); }
      else if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); go(index - 1); }
    }}
  >
    <div className={`flex min-h-0 flex-col gap-3 ${stage ? "flex-1 @[720px]/slides:flex-row" : ""}`}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={stage ? "flex min-h-0 flex-1 items-center justify-center [container-type:size]" : ""}>
          <div
            key={index}
            className="overflow-hidden rounded-lg border border-border motion-safe:animate-[work-visual-fade_200ms_ease-out]"
            style={stage ? { width: "min(100cqw, calc(100cqh * 16 / 9))" } : undefined}
            role="group"
            aria-roledescription="slide"
            aria-label={`Slide ${index + 1} of ${total}: ${slide.title}`}
          ><SlideCanvas slide={slide} index={index} total={total} deck={block.title} /></div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" className={visualIconButton} aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={16} aria-hidden /></button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">{index + 1} / {total}</span>
            <button type="button" className={visualIconButton} aria-label="Next slide" disabled={index === total - 1} onClick={() => go(index + 1)}><ChevronRight size={16} aria-hidden /></button>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className={`${visualButton} ${notes ? "bg-secondary !text-foreground" : ""}`} aria-pressed={notes} disabled={!block.slides.some(item => item.notes)} onClick={() => setNotes(!notes)}><StickyNote size={13} aria-hidden />Notes</button>
            <button ref={presentButton} type="button" className={`${visualButton} bg-secondary !text-foreground`} onClick={() => setPresenting(true)}><Play size={13} aria-hidden />Present</button>
          </div>
        </div>
        {notes && <div role="region" aria-label="Speaker notes" className="mt-2 max-h-32 shrink-0 overflow-y-auto rounded-lg bg-secondary px-3.5 py-2.5 text-[13px] leading-6 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{slide.notes ?? "No notes for this slide."}</div>}
      </div>
      <ol
        ref={rail}
        aria-label="Slides"
        className={`m-0 flex shrink-0 list-none gap-2.5 overflow-auto p-0.5 ${stage ? "@[720px]/slides:w-48 @[720px]/slides:flex-col @[720px]/slides:pr-1" : ""}`}
      >
        {block.slides.map((item, i) => <li key={i} data-slide={i} className={`flex shrink-0 items-start gap-2 ${stage ? "@[720px]/slides:w-full" : ""}`}>
          <span className={`w-4 pt-1 text-right text-[11px] tabular-nums ${i === index ? "font-semibold text-foreground" : "text-muted-foreground"}`} aria-hidden>{i + 1}</span>
          <button
            type="button"
            aria-label={`Slide ${i + 1}: ${item.title}`}
            aria-current={i === index ? "true" : undefined}
            onClick={() => setIndex(i)}
            className={`w-32 overflow-hidden rounded-md outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${stage ? "@[720px]/slides:w-full" : ""} ${i === index ? "ring-2 ring-foreground/60" : "ring-1 ring-border hover:ring-border-strong"}`}
          ><span className="pointer-events-none block" inert><SlideCanvas slide={item} index={i} total={total} deck={block.title} /></span></button>
        </li>)}
      </ol>
    </div>
    {presenting && <Presenter block={block} start={index} onClose={closePresenter} />}
  </div>;
}
