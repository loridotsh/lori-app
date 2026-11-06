"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import type { StepsBlock } from "@lori-enterprise/contracts";

export function VisualSteps({ block }: { block: StepsBlock }) {
  const last = block.items.length - 1;
  return <ol aria-label={`${block.title} steps`} className="m-0 max-w-[72ch] list-none p-0">
    {block.items.map((item, index) => <li key={index} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 pb-6 last:pb-0">
      {index < last && <span aria-hidden="true" className="absolute top-8 bottom-1 left-[13.5px] w-px bg-border" />}
      <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-secondary text-xs font-medium tabular-nums text-muted-foreground">{index + 1}</span>
      <div className="min-w-0 pt-[3px]">
        <h4 className="m-0 text-sm font-medium leading-[22px] text-foreground [overflow-wrap:anywhere]"><span className="sr-only">Step {index + 1}: </span>{item.title}</h4>
        <p className="mt-1 mb-0 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{item.text}</p>
      </div>
    </li>)}
  </ol>;
}
