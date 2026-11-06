"use client";

import { Component, memo, useId, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDown, ChevronRight, CopyIcon, Download, Maximize2 } from "lucide-react";
import { parseVisual, visualText, type CloudToolInvocation, type CloudVisual, type VisualBlock } from "@lori-enterprise/contracts";
import { Dialog } from "@/components/ui/dialog";
import { visualKind } from "./kinds";
import { VisualSlides } from "./VisualSlides";
import { VisualReport } from "./VisualReport";
import { ShimmerText } from "../shimmer-text";
import { VisualChart } from "./VisualChart";
import { VisualTable } from "./VisualTable";
import { VisualCalculator } from "./VisualCalculator";
import { VisualSteps } from "./VisualSteps";
import { VisualSimulation } from "./VisualSimulation";
import { visualIconButton } from "./ui";

import { VisualDiagram } from "./VisualDiagram";
import { VisualMindmap } from "./VisualMindmap";
import { VisualTimeline } from "./VisualTimeline";
import { VisualQuiz } from "./VisualQuiz";
import { VisualFlashcards } from "./VisualFlashcards";
import { exportVisual } from "./exportVisual";
import { useCopyFeedback } from "./useCopyFeedback";

function summaryOf(item: CloudToolInvocation): string {
  return typeof item.arguments?.summary === "string" ? item.arguments.summary.slice(0, 1200) : "";
}

export function VisualFallback({ summary, message = "This visual couldn’t be displayed. Ask Lori to recreate it." }: { summary: string; message?: string }) {
  return <section aria-label="Visual unavailable" className="my-3 min-w-0 text-sm leading-6">
    <p role="status" className="text-muted-foreground">{message}</p>
    {summary && <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{summary}</p>}
  </section>;
}

/** A faulty visual never takes the conversation, approvals, or composer down. */
export class VisualBoundary extends Component<{ summary: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <VisualFallback summary={this.props.summary} /> : this.props.children; }
}

function BlockView({ block, active, stage, canExport }: { block: VisualBlock; active: boolean; stage: boolean; canExport: boolean }) {
  return block.type === "diagram" ? <VisualDiagram block={block} active={active} />
    : block.type === "mindmap" ? <VisualMindmap block={block} stage={stage} canExport={canExport} />
    : block.type === "timeline" ? <VisualTimeline block={block} />
    : block.type === "quiz" ? <VisualQuiz block={block} stage={stage} />
    : block.type === "flashcards" ? <VisualFlashcards block={block} stage={stage} />
    : block.type === "slides" ? <VisualSlides block={block} stage={stage} />
    : block.type === "report" ? <VisualReport block={block} stage={stage} />
    : block.type === "chart" ? <VisualChart block={block} />
    : block.type === "table" ? <VisualTable block={block} />
    : block.type === "calculator" ? <VisualCalculator block={block} />
    : block.type === "steps" ? <VisualSteps block={block} />
    : block.type === "simulation" ? <VisualSimulation block={block} active={active} />
    : <dl className="m-0 grid grid-cols-1 gap-4 @min-[360px]:grid-cols-2">
      {block.items.map((item, itemIndex) => <div key={itemIndex} className="min-w-0"><dt className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.label}</dt><dd className="m-0 mt-1 text-lg font-medium tracking-tight tabular-nums [overflow-wrap:anywhere]">{item.value}</dd>{item.detail && <dd className="m-0 mt-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</dd>}</div>)}
    </dl>;
}

const sourceSeparators = /^[\s;,·|–—-]+|[\s;,·|–—-]+$/g;

/** One short line per source: the site name and any note, with the full reference kept for tooltips and screen readers. */
export function sourceMeta(reference: string): string {
  const text = reference.replace(/\s+/g, " ").trim();
  const url = text.match(/https?:\/\/[^\s;,)]+/i)?.[0];
  if (!url) return text;
  let site: string;
  try { site = new URL(url).hostname.replace(/^www\./, ""); } catch { site = url; }
  const note = text.replace(`(${url})`, " ").replace(url, " ").replace(/\s+([,;])/g, "$1").split(/;|\s·\s/)
    .map(part => part.replace(sourceSeparators, "").replace(/\s+/g, " ")).filter(Boolean).join(" · ");
  return note ? `${site} · ${note}` : site;
}

function SourceList({ visual, id }: { visual: CloudVisual; id?: string }) {
  return <ol id={id} aria-label="Sources" className="m-0 list-none space-y-0.5 p-0">
    {(visual.sources ?? []).map((source, index) => <li key={index} title={`${source.label}\n${source.reference}`} className="flex min-w-0 items-baseline gap-2 text-xs leading-5">
      <span aria-hidden className="w-3.5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
      <span className="min-w-0 truncate"><span className="font-medium text-foreground">{source.label}</span><span aria-hidden className="text-muted-foreground"> · {sourceMeta(source.reference)}</span><span className="sr-only">{` ${source.reference}`}</span></span>
    </li>)}
  </ol>;
}

function InlineSources({ visual }: { visual: CloudVisual }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const total = visual.sources?.length ?? 0;
  if (!total) return null;
  return <footer className="mt-4 border-t border-border/60 pt-2">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors duration-150 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
      <ChevronRight size={13} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />{total} {total === 1 ? "source" : "sources"}
    </button>
    <div hidden={!open} className="pt-1 pb-0.5"><SourceList visual={visual} id={id} /></div>
  </footer>;
}

export function VisualDocument({ visual, active = true, canExport = true, layout = "inline", showTitle = true, expandable = true }: { visual: CloudVisual; active?: boolean; canExport?: boolean; layout?: "inline" | "stage"; showTitle?: boolean; expandable?: boolean }) {
  const id = useId();
  const { copy, status } = useCopyFeedback();
  const [exportState, setExportState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);
  const kind = visualKind(visual);
  const [details, setDetails] = useState(!kind.immersive);
  const stage = layout === "stage";
  const KindIcon = kind.icon;
  const sources = visual.sources?.length ?? 0;
  const toolbar = <div className="flex shrink-0 items-center gap-1">
    <button type="button" className={visualIconButton} aria-label="Copy visual as text" title="Copy original data, default inputs and answer keys" onClick={() => void copy(visualText(visual))}>
      {status === "copied" ? <CheckIcon size={15} aria-hidden="true" /> : <CopyIcon size={15} aria-hidden="true" />}
    </button>
    {canExport && <button type="button" className={visualIconButton} disabled={exportState === "saving"} aria-label="Download visual data" title="Download original visual data as JSON" onClick={async () => {
      setExportState("saving");
      try { setExportState(await exportVisual(visual) ? "saved" : "idle"); } catch { setExportState("failed"); }
    }}><Download size={15} aria-hidden /></button>}
    {expandable && <button type="button" className={visualIconButton} aria-label={`Open ${visual.title} in a larger view`} title="Open in a larger view" onClick={() => setExpanded(true)}><Maximize2 size={14} aria-hidden /></button>}
  </div>;
  const feedback = <>
    <span className="sr-only" role="status">{status === "copied" ? "Visual copied with its original data and default inputs." : ""}</span>
    {status === "failed" && <p role="alert" className="mt-2 text-xs text-destructive">Could not copy. Try again.</p>}
    {exportState === "failed" && <p role="alert" className="mt-2 text-xs text-destructive">Could not download this visual. Try again.</p>}
    <span className="sr-only" role="status">{exportState === "saved" ? "Visual download started." : ""}</span>
  </>;
  const label = <p className="m-0 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"><KindIcon size={12} aria-hidden /><span>{kind.label}</span>{kind.detail && <><span aria-hidden>·</span><span className="tabular-nums">{kind.detail}</span></>}</p>;
  const titled = (block: VisualBlock) => visual.blocks.length > 1 || block.title !== visual.title;
  const dialog = expandable && expanded && <Dialog open title={visual.title} description={[kind.label, kind.detail].filter(Boolean).join(" · ")} onClose={() => setExpanded(false)} className="w-[min(1440px,96vw)] max-w-none max-h-[94dvh]" contentClassName="flex min-h-0 flex-col">
    <div className="flex h-[min(860px,calc(94dvh-7rem))] min-h-0 flex-col"><VisualDocument visual={visual} active={active} canExport={canExport} layout="stage" showTitle={false} expandable={false} /></div>
  </Dialog>;

  if (stage) {
    return <section aria-labelledby={id} className="@container flex h-full min-h-0 min-w-0 flex-col text-foreground selection:bg-primary/20">
      <header className="shrink-0 pb-3">
        <h2 id={id} className={showTitle ? "m-0 mb-1.5 text-[17px] font-semibold leading-6 tracking-tight [overflow-wrap:anywhere]" : "sr-only"}>{visual.title}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {label}
          <span aria-hidden className="h-3 w-px bg-border" />
          <button type="button" aria-expanded={details} aria-controls={`${id}-details`} onClick={() => setDetails(!details)} className="-ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors duration-150 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
            {sources ? `Summary and ${sources} ${sources === 1 ? "source" : "sources"}` : "Summary"}<ChevronDown size={12} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${details ? "rotate-180" : ""}`} />
          </button>
          <div className="ml-auto">{toolbar}</div>
        </div>
        <div id={`${id}-details`} hidden={!details} className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-secondary/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <p className="m-0 whitespace-pre-wrap text-[13px] leading-6 text-foreground [overflow-wrap:anywhere]">{visual.summary}</p>
          {sources > 0 && <div className="mt-2.5 border-t border-border pt-2.5"><h3 className="m-0 mb-1 text-xs font-medium text-foreground">Sources</h3><SourceList visual={visual} /></div>}
        </div>
        {feedback}
      </header>
      {kind.immersive
        ? <div className="flex min-h-0 flex-1 flex-col"><BlockView block={visual.blocks[0]!} active={active} stage canExport={canExport} /></div>
        : <div className="min-h-0 flex-1 space-y-8 overflow-y-auto pb-4">
          {visual.blocks.map((block, index) => <section key={index} aria-labelledby={titled(block) ? `${id}-block-${index}` : id} className="min-w-0">
            {titled(block) && <h3 id={`${id}-block-${index}`} className="mt-0 mb-3 text-[13px] font-medium leading-5 [overflow-wrap:anywhere]">{block.title}</h3>}
            <BlockView block={block} active={active} stage={false} canExport={canExport} />
          </section>)}
        </div>}
      {dialog}
    </section>;
  }

  return <section aria-labelledby={id} className="work-response-part @container my-4 min-w-0 border-y border-border/60 py-3.5 text-foreground selection:bg-primary/20">
    <header>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 pt-0.5">
          {label}
          <h2 id={id} className="m-0 mt-1 text-base font-semibold leading-6 tracking-tight [overflow-wrap:anywhere]">{visual.title}</h2>
        </div>
        {toolbar}
      </div>
      <p className="mt-1.5 mb-0 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{visual.summary}</p>
      {feedback}
    </header>
    <div className="space-y-5 pt-4">
      {visual.blocks.map((block, index) => <section key={index} aria-labelledby={titled(block) ? `${id}-block-${index}` : id} className="min-w-0">
        {titled(block) && <h3 id={`${id}-block-${index}`} className="mt-0 mb-3 text-[13px] font-medium leading-5 [overflow-wrap:anywhere]">{block.title}</h3>}
        <BlockView block={block} active={active} stage={false} canExport={canExport} />
      </section>)}
    </div>
    <InlineSources visual={visual} />
    {dialog}
  </section>;
}

export const CloudVisualActivity = memo(function CloudVisualActivity({ item, active = true, canExport = true }: { item: CloudToolInvocation; active?: boolean; canExport?: boolean }) {
  const visual = useMemo(() => {
    const output = item.output;
    if (item.status !== "completed" || !output || typeof output !== "object" ||
        !("kind" in output) || output.kind !== "cloud_visual" || !("presented" in output) || output.presented !== true) return null;
    // Arguments are already durable and included in both SSE and snapshots.
    // Use them only after the successful receipt; a compact model preview cannot truncate the visual.
    return parseVisual(item.arguments);
  }, [item.status, item.arguments, item.output]);
  if (item.status === "running" || item.status === "pendingExecution") return <div role="status" className="my-3 text-sm text-muted-foreground"><ShimmerText>Preparing a visual</ShimmerText></div>;
  if (!visual) return <VisualFallback summary={summaryOf(item)} message={item.status === "unknown" ? "The visual’s completion could not be confirmed. Ask Lori to check it." : undefined} />;
  return <VisualBoundary key={item.id} summary={visual.summary}><VisualDocument visual={visual} active={active} canExport={canExport} /></VisualBoundary>;
});
