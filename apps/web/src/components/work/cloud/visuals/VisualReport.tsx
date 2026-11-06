"use client";

import { Fragment, useId, useMemo, useRef } from "react";
import type { ReportBlock } from "@lori-enterprise/contracts";
import { emphasis, reportParts } from "./reportText";

function Inline({ text }: { text: string }) {
  return <>{emphasis(text).map((piece, index) => piece.strong ? <strong key={index} className="font-semibold text-foreground">{piece.text}</strong> : <Fragment key={index}>{piece.text}</Fragment>)}</>;
}

export function VisualReport({ block, stage = false }: { block: ReportBlock; stage?: boolean }) {
  const id = useId();
  const sections = useMemo(() => block.sections.map(section => ({ ...section, parts: reportParts(section.body) })), [block.sections]);
  const scroller = useRef<HTMLDivElement>(null);
  const contents = block.sections.length >= 3;
  // Scroll only the report itself; scrollIntoView would also move the conversation.
  const jump = (index: number) => {
    const box = scroller.current;
    const target = document.getElementById(`${id}-${index}`);
    if (!box || !target) return;
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    box.scrollTo?.({ top, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  };
  return <div ref={scroller} tabIndex={stage ? undefined : 0} role={stage ? undefined : "region"} aria-label={stage ? undefined : `${block.title} report`} className={stage ? "h-full min-h-0 overflow-y-auto" : "max-h-[min(440px,60vh)] overflow-y-auto overscroll-contain rounded-lg border border-border px-4 py-3.5 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring"}>
    <article className={`mx-auto w-full text-foreground ${stage ? "max-w-[68ch] px-1 py-6 text-[14px] leading-[1.75]" : "text-[13px] leading-[1.7]"}`}>
      {contents && <nav aria-label="Contents" className={`${stage ? "mb-7" : "mb-5"} border-l-2 border-border-strong pl-3.5`}>
        <p className="m-0 mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Contents</p>
        <ol className="m-0 list-none p-0">
          {block.sections.map((section, index) => <li key={index}><a href={`#${id}-${index}`} className="text-[13px] leading-6 text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={event => { event.preventDefault(); jump(index); }}><span className="mr-2 tabular-nums text-muted-foreground/80">{index + 1}.</span>{section.heading}</a></li>)}
        </ol>
      </nav>}
      {sections.map((section, index) => <section key={index} aria-labelledby={`${id}-${index}`} className={index ? stage ? "mt-7" : "mt-5" : ""}>
        <h4 id={`${id}-${index}`} tabIndex={-1} className={`m-0 font-semibold tracking-tight outline-none [overflow-wrap:anywhere] ${stage ? "mb-2.5 text-[16px] leading-7" : "mb-2 text-[14px] leading-6"}`}>{section.heading}</h4>
        <div className={`flex flex-col text-foreground/90 [overflow-wrap:anywhere] ${stage ? "gap-3.5" : "gap-2.5"}`}>
          {section.parts.map((part, partIndex) => part.kind === "paragraph"
            ? <p key={partIndex} className="m-0">{part.lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}<Inline text={line} /></Fragment>)}</p>
            : part.kind === "bullets"
              ? <ul key={partIndex} className="m-0 list-disc space-y-1.5 pl-5 marker:text-muted-foreground">{part.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1"><Inline text={item} /></li>)}</ul>
              : <ol key={partIndex} start={part.start} className="m-0 list-decimal space-y-1.5 pl-5 marker:text-muted-foreground marker:tabular-nums">{part.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1"><Inline text={item} /></li>)}</ol>)}
        </div>
      </section>)}
    </article>
  </div>;
}
