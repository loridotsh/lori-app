"use client";

import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, RotateCcw, Shuffle, X } from "lucide-react";
import type { FlashcardsBlock } from "@lori-enterprise/contracts";
import { visualButton, visualIconButton } from "./ui";

function shuffled(items: number[]): number[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [next[index], next[swap]] = [next[swap]!, next[index]!];
  }
  return next;
}

export function VisualFlashcards({ block, stage = false }: { block: FlashcardsBlock; stage?: boolean }) {
  const all = block.cards.map((_, index) => index);
  const [order, setOrder] = useState(all);
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [marks, setMarks] = useState<Record<number, "got" | "missed">>({});
  const [done, setDone] = useState(false);
  const index = order[position]!;
  const card = block.cards[index]!;
  const got = order.filter(item => marks[item] === "got").length;
  const missed = order.filter(item => marks[item] === "missed");

  const move = (next: number) => { setPosition(next); setRevealed(false); };
  const start = (items: number[]) => { setOrder(items); setMarks({}); setDone(false); move(0); };
  const mark = (value: "got" | "missed") => {
    const next = { ...marks, [index]: value };
    setMarks(next);
    const remaining = order.findIndex((item, step) => step > position && next[item] === undefined);
    const earlier = order.findIndex(item => next[item] === undefined);
    if (remaining >= 0) move(remaining);
    else if (earlier >= 0) move(earlier);
    else setDone(true);
  };

  if (done) {
    return <div className={`flex flex-col items-center justify-center text-center ${stage ? "h-full min-h-0 py-8" : "py-6"}`}>
      <p className="m-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">Session complete</p>
      <p className="mt-2 mb-1 text-[28px] font-semibold tracking-tight tabular-nums" role="status">{got} of {order.length} known</p>
      <p className="m-0 max-w-sm text-[13px] leading-6 text-muted-foreground">{missed.length ? `Review the ${missed.length} ${missed.length === 1 ? "card" : "cards"} you missed to lock them in.` : "You knew every card in this set."}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {missed.length > 0 && <button type="button" className={`${visualButton} bg-secondary !text-foreground`} onClick={() => start(missed)}><RotateCcw size={13} aria-hidden />Review {missed.length} missed</button>}
        <button type="button" className={visualButton} onClick={() => start(all)}><RotateCcw size={13} aria-hidden />Start over</button>
      </div>
    </div>;
  }

  return <div
    className={`flex flex-col outline-none ${stage ? "h-full min-h-0" : ""}`}
    tabIndex={-1}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.key === " " || event.key === "Enter") && (event.target as HTMLElement).dataset.flashcard !== undefined) return;
      if (event.key === "ArrowRight" && position < order.length - 1) { event.preventDefault(); move(position + 1); }
      else if (event.key === "ArrowLeft" && position > 0) { event.preventDefault(); move(position - 1); }
    }}
  >
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums" aria-live="polite">Card {position + 1} of {order.length}</span>
      <span className="flex items-center gap-3 tabular-nums" role="status">
        <span className="inline-flex items-center gap-1"><Check size={12} className="text-success" aria-hidden />{got} got it</span>
        <span className="inline-flex items-center gap-1"><X size={12} className="text-destructive" aria-hidden />{missed.length} missed</span>
      </span>
    </div>

    <div className={`flex min-h-0 items-center justify-center ${stage ? "flex-1 py-6" : "py-3"}`}>
      <button
        type="button"
        data-flashcard=""
        aria-label={revealed ? `Answer: ${card.back}. Show question` : `Question: ${card.front}. Show answer`}
        aria-pressed={revealed}
        onClick={() => setRevealed(!revealed)}
        className={`group relative w-full cursor-pointer rounded-2xl outline-none [perspective:1600px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${stage ? "aspect-[16/10] max-h-full max-w-[44rem]" : "min-h-44"}`}
      >
        <span className={`absolute inset-0 block transition-transform duration-500 [transform-style:preserve-3d] motion-reduce:transition-none ${revealed ? "[transform:rotateY(180deg)]" : ""}`} style={{ transitionTimingFunction: "cubic-bezier(0.2, 0.7, 0.2, 1)" }}>
          <span aria-hidden={revealed} className="absolute inset-0 flex flex-col rounded-2xl border border-border bg-card p-5 [backface-visibility:hidden]">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Question</span>
            <span className="flex flex-1 items-center justify-center overflow-y-auto py-3 text-center text-[17px] leading-7 font-medium tracking-tight whitespace-pre-wrap [overflow-wrap:anywhere]">{card.front}</span>
            <span className="text-center text-[11px] text-muted-foreground">Click or press Space to see the answer</span>
          </span>
          <span aria-hidden={!revealed} className="absolute inset-0 flex flex-col rounded-2xl border border-border-strong bg-secondary p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <span className="text-[11px] font-medium tracking-wide text-primary uppercase">Answer</span>
            <span className="flex flex-1 items-center justify-center overflow-y-auto py-3 text-center text-[15px] leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">{card.back}</span>
            <span className="line-clamp-1 text-center text-[11px] text-muted-foreground">{card.front}</span>
          </span>
        </span>
        {!stage && <span aria-hidden className="invisible block p-5 text-[17px] leading-7 whitespace-pre-wrap">{card.front.length > card.back.length ? card.front : card.back}<span className="block h-10" /></span>}
      </button>
    </div>

    <div className="flex flex-wrap items-center justify-center gap-2">
      <button type="button" className={`${visualButton} min-h-8 border border-destructive/40 px-4 !text-destructive hover:bg-destructive-muted`} onClick={() => mark("missed")}><X size={14} aria-hidden />Missed it</button>
      <button type="button" className={`${visualButton} min-h-8 border border-success/40 px-4 !text-success-muted-foreground hover:bg-success-muted`} onClick={() => mark("got")}><Check size={14} aria-hidden />Got it</button>
    </div>

    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
      <button type="button" className={visualButton} disabled={position === 0} onClick={() => move(position - 1)} aria-label={`Previous card in ${block.title}`}><ChevronLeft size={14} aria-hidden />Previous</button>
      <div className="flex items-center gap-1">
        <button type="button" className={visualIconButton} aria-label="Shuffle cards" title="Shuffle" onClick={() => { setOrder(shuffled(order)); move(0); }}><Shuffle size={14} aria-hidden /></button>
        <button type="button" className={visualIconButton} aria-label="Restart cards" title="Restart" onClick={() => start(all)}><RotateCcw size={14} aria-hidden /></button>
      </div>
      <button type="button" className={visualButton} disabled={position === order.length - 1} onClick={() => move(position + 1)} aria-label={`Next card in ${block.title}`}>Next<ChevronRight size={14} aria-hidden /></button>
    </div>
    <p className="mt-1.5 mb-0 text-[11px] leading-4 text-muted-foreground">Progress stays in this view and resets when reopened.</p>
  </div>;
}
