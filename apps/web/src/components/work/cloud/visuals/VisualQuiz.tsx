"use client";

import { useId, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Lightbulb, RotateCcw, X } from "lucide-react";
import type { QuizBlock } from "@lori-enterprise/contracts";
import { visualButton } from "./ui";

const letters = "ABCDEF";

export function VisualQuiz({ block, stage = false }: { block: QuizBlock; stage?: boolean }) {
  const id = useId();
  const [order, setOrder] = useState(() => block.questions.map((_, index) => index));
  const [position, setPosition] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [hints, setHints] = useState(new Set<number>());
  const [finished, setFinished] = useState(false);
  const index = order[position]!;
  const question = block.questions[index]!;
  const chosen = answers[index];
  const revealed = chosen !== undefined;
  const correct = useMemo(() => order.filter(item => answers[item] === block.questions[item]!.answer).length, [order, answers, block.questions]);
  const answered = order.filter(item => answers[item] !== undefined).length;
  const last = position === order.length - 1;

  const choose = (option: number) => { if (!revealed) setAnswers(previous => ({ ...previous, [index]: option })); };
  const restart = (items: number[]) => {
    setOrder(items); setPosition(0); setFinished(false); setHints(new Set());
    setAnswers(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !items.includes(Number(key)))));
  };
  const missed = order.filter(item => answers[item] !== block.questions[item]!.answer);

  if (finished) {
    return <div className={`flex flex-col ${stage ? "h-full min-h-0 overflow-y-auto" : ""}`}>
      <div className={`mx-auto w-full ${stage ? "max-w-[44rem] px-1 py-6" : ""}`}>
        <p className="m-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">Results</p>
        <p className="mt-2 mb-1 text-[28px] font-semibold tracking-tight tabular-nums" role="status">{correct} / {order.length}</p>
        <p className="m-0 text-[13px] leading-6 text-muted-foreground">{correct === order.length ? "Every answer correct. Nicely done." : `${missed.length} to review. Retry them while the explanations are fresh.`}</p>
        <ol className="mt-5 mb-0 list-none space-y-1 p-0">
          {order.map((item, step) => {
            const right = answers[item] === block.questions[item]!.answer;
            return <li key={item}><button type="button" className="flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left text-[13px] leading-6 outline-none transition-colors duration-150 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none" onClick={() => { setFinished(false); setPosition(step); }}>
              <span className={`mt-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full ${right ? "bg-success-muted text-success-muted-foreground" : "bg-destructive-muted text-destructive-muted-foreground"}`}>{right ? <Check size={11} strokeWidth={3} aria-hidden /> : <X size={11} strokeWidth={3} aria-hidden />}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]"><span className="sr-only">{right ? "Correct: " : "Incorrect: "}</span>{block.questions[item]!.question}</span>
            </button></li>;
          })}
        </ol>
        <div className="mt-5 flex flex-wrap gap-2">
          {missed.length > 0 && <button type="button" className={`${visualButton} bg-secondary !text-foreground`} onClick={() => restart(missed)}><RotateCcw size={13} aria-hidden />Retry {missed.length} missed</button>}
          <button type="button" className={visualButton} onClick={() => restart(block.questions.map((_, item) => item))}><RotateCcw size={13} aria-hidden />Retake quiz</button>
        </div>
      </div>
    </div>;
  }

  return <div
    className={`flex flex-col outline-none ${stage ? "h-full min-h-0" : ""}`}
    tabIndex={-1}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toUpperCase();
      const option = letters.indexOf(key) >= 0 ? letters.indexOf(key) : /^[1-6]$/.test(key) ? Number(key) - 1 : -1;
      if (option >= 0 && option < question.options.length && !revealed) { event.preventDefault(); choose(option); }
      else if (event.key === "ArrowRight" && !last) { event.preventDefault(); setPosition(position + 1); }
      else if (event.key === "ArrowLeft" && position > 0) { event.preventDefault(); setPosition(position - 1); }
    }}
  >
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums" aria-live="polite">{position + 1} / {order.length}</span>
      <span className="tabular-nums" role="status">{answered ? `${correct} of ${answered} correct` : "Choose an answer to check it"}</span>
    </div>
    <div className="mt-2 flex gap-1" aria-hidden="true">
      {order.map((item, step) => <span key={item} className={`h-1 min-w-0 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none ${answers[item] === undefined ? step === position ? "bg-muted-foreground/60" : "bg-border" : answers[item] === block.questions[item]!.answer ? "bg-success" : "bg-destructive"}`} />)}
    </div>

    <div className={`min-h-0 ${stage ? "flex-1 overflow-y-auto py-5" : "py-3.5"}`}>
      <div key={`${index}-${position}`} className={`mx-auto w-full motion-safe:animate-[work-visual-rise_180ms_ease-out] ${stage ? "max-w-[42rem]" : ""}`}>
        <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={revealed ? `${id}-feedback` : undefined}>
          <legend className={`mb-3.5 w-full whitespace-pre-wrap font-medium tracking-tight [overflow-wrap:anywhere] ${stage ? "text-[16px] leading-7" : "text-[14px] leading-6"}`}>{question.question}</legend>
          <div role="radiogroup" aria-label="Answer options" className="space-y-2">
            {question.options.map((option, item) => {
              const isAnswer = item === question.answer;
              const isChosen = item === chosen;
              const state = !revealed ? "idle" : isAnswer ? "right" : isChosen ? "wrong" : "other";
              const rationale = question.rationales?.[item];
              return <button
                key={item}
                type="button"
                role="radio"
                aria-checked={isChosen}
                aria-disabled={revealed}
                onClick={() => choose(item)}
                className={`group flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                  state === "idle" ? "cursor-pointer border-border bg-card hover:border-border-strong hover:bg-secondary"
                    : state === "right" ? "border-success/60 bg-success-muted/50"
                    : state === "wrong" ? "border-destructive/60 bg-destructive-muted/50"
                    : "cursor-default border-border opacity-60"}`}
              >
                <span className={`mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  state === "right" ? "bg-success text-success-foreground" : state === "wrong" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-muted-foreground group-hover:text-foreground"}`}>
                  {state === "right" ? <Check size={11} strokeWidth={3} aria-hidden /> : state === "wrong" ? <X size={11} strokeWidth={3} aria-hidden /> : letters[item]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block [overflow-wrap:anywhere] ${stage ? "text-[14px] leading-[22px]" : "text-[13px] leading-[22px]"}`}>{option}</span>
                  {revealed && (state === "right" || state === "wrong" || rationale) && <span className="mt-0.5 block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                    {state === "right" && <span className="mr-1.5 font-medium text-success-muted-foreground">{isChosen ? "That’s right!" : "Correct answer"}</span>}
                    {state === "wrong" && <span className="mr-1.5 font-medium text-destructive-muted-foreground">Not quite</span>}
                    {rationale}
                  </span>}
                </span>
              </button>;
            })}
          </div>
        </fieldset>
        {revealed && <div id={`${id}-feedback`} role="status" className={question.explanation ? "mt-3 rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]" : "sr-only"}>
          <span className="sr-only">{chosen === question.answer ? "Correct" : `Correct answer: ${question.options[question.answer]}`}</span>
          {question.explanation && <><span className="sr-only">. </span><span className="mr-1.5 font-medium text-foreground">Why</span>{question.explanation}</>}
        </div>}
        {!revealed && question.hint && (hints.has(index)
          ? <p role="note" className="mt-3 mb-0 flex gap-2 rounded-lg bg-warning-muted px-3 py-2.5 text-xs leading-5 text-warning-muted-foreground [overflow-wrap:anywhere]"><Lightbulb size={14} className="mt-0.5 shrink-0" aria-hidden /><span>{question.hint}</span></p>
          : <button type="button" className={`${visualButton} mt-2 -ml-2.5`} onClick={() => setHints(previous => new Set(previous).add(index))}><Lightbulb size={13} aria-hidden />Hint</button>)}
      </div>
    </div>

    <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
      <button type="button" className={visualButton} disabled={position === 0} onClick={() => setPosition(position - 1)} aria-label={`Previous question in ${block.title}`}><ChevronLeft size={14} aria-hidden />Previous</button>
      <button type="button" className={visualButton} onClick={() => restart(block.questions.map((_, item) => item))}><RotateCcw size={13} aria-hidden />Restart quiz</button>
      {last
        ? <button type="button" className={`${visualButton} ${answered === order.length ? "bg-secondary !text-foreground" : ""}`} disabled={answered === 0} onClick={() => setFinished(true)}>See results<ChevronRight size={14} aria-hidden /></button>
        : <button type="button" className={`${visualButton} ${revealed ? "bg-secondary !text-foreground" : ""}`} onClick={() => setPosition(position + 1)} aria-label={`Next question in ${block.title}`}>Next<ChevronRight size={14} aria-hidden /></button>}
    </div>
    <p className="mt-1.5 mb-0 text-[11px] leading-4 text-muted-foreground">Practice stays in this view. Answers are not sent to Lori. Press A–F to answer, ← → to move.</p>
  </div>;
}
