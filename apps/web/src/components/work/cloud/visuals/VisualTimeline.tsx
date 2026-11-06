"use client";

import type { TimelineBlock } from "@lori-enterprise/contracts";

export function VisualTimeline({ block }: { block: TimelineBlock }) {
  return <ol aria-label={block.title} className="m-0 list-none space-y-0 p-0">
    {block.items.map((item, index) => <li key={index} className="relative grid min-w-0 grid-cols-1 gap-1 border-l border-border pb-6 pl-5 last:pb-0 @min-[480px]:grid-cols-[100px_minmax(0,1fr)] @min-[480px]:gap-5">
      <span aria-hidden className="absolute -left-1 top-1.5 size-2 rounded-full bg-muted-foreground" />
      <span className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{item.label}</span>
      <div className="min-w-0"><h4 className="m-0 text-[13px] font-medium leading-6 [overflow-wrap:anywhere]">{item.title}</h4><p className="mt-1 mb-0 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{item.text}</p></div>
    </li>)}
  </ol>;
}
