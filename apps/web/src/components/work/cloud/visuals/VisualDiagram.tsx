"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Maximize2, Minus, Plus } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import type { DiagramBlock } from "@lori-enterprise/contracts";
import { useCopyFeedback } from "./useCopyFeedback";
import { mermaidSource } from "./mermaidSource";
import { renderMermaid } from "./mermaidRenderer";
import { visualButton, visualIconButton } from "./ui";

function ExpandedDiagram({ title, source, url, width, height, onClose }: {
  title: string; source: string; url: string; width: number; height: number; onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { copy, status } = useCopyFeedback();
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: Math.max(1, element.clientWidth - 32), height: Math.max(1, element.clientHeight - 32) });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const fit = () => setScale(Math.min(1, size.width / width, size.height / height));
  return <Dialog open title={title} onClose={onClose} className="w-[min(1280px,96vw)] max-w-none max-h-[92dvh]">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <button type="button" className={visualButton} onClick={() => void copy(source)}>{status === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}Copy Mermaid</button>
      <div role="group" aria-label="Diagram zoom" className="flex items-center gap-1">
        <button type="button" className={visualIconButton} aria-label="Zoom out" disabled={scale <= .1} onClick={() => setScale(value => Math.max(.1, value - .25))}><Minus size={15} aria-hidden /></button>
        <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
        <button type="button" className={visualIconButton} aria-label="Zoom in" disabled={scale >= 4} onClick={() => setScale(value => Math.min(4, value + .25))}><Plus size={15} aria-hidden /></button>
        <button type="button" className={visualButton} disabled={!size.width} onClick={fit}>Fit</button>
        <button type="button" className={visualButton} aria-label="Actual size" onClick={() => setScale(1)}>100%</button>
      </div>
    </div>
    <div ref={viewport} tabIndex={0} role="region" aria-label="Expanded diagram, scroll to explore" className="h-[min(65dvh,720px)] overflow-auto rounded-md bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <img alt={title} src={url} draggable={false} style={{ width: width * scale, height: height * scale, maxWidth: "none" }} className="mx-auto block" />
    </div>
    <span className="sr-only" role="status">{status === "copied" ? "Mermaid source copied." : ""}</span>
    {status === "failed" && <p role="alert" className="mt-2 text-xs text-destructive">Could not copy the diagram. Try again.</p>}
  </Dialog>;
}

export function VisualDiagram({ block, active = true }: { block: DiagramBlock; active?: boolean }) {
  const id = useId();
  const source = useMemo(() => mermaidSource(block), [block]);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const [result, setResult] = useState<{ key: string; url?: string; width?: number; height?: number; failed?: boolean } | null>(null);
  useEffect(() => { setExpanded(false); }, [source, active]);
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    void renderMermaid(source, () => !cancelled).then(rendered => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob([rendered.svg], { type: "image/svg+xml" }));
      setResult({ key: source, url, width: rendered.width, height: rendered.height });
    }).catch(() => { if (!cancelled) setResult({ key: source, failed: true }); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [source]);
  const current = result?.key === source ? result : null;
  const showDetails = details || current?.failed;
  const close = () => {
    setExpanded(false);
    requestAnimationFrame(() => { if (activeRef.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true }); });
  };
  return <div className="min-w-0 space-y-2">
    {current?.url ? <button ref={opener} type="button" aria-label={`Expand ${block.title}`} aria-haspopup="dialog" onClick={() => setExpanded(true)} className="group relative block w-full cursor-zoom-in rounded-md border border-border/50 bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <img alt={block.title} src={current.url} width={current.width} height={current.height} draggable={false} className="mx-auto h-auto max-h-72 max-w-full object-contain" onError={() => setResult({ key: source, failed: true })} />
      <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-white/95 px-1.5 py-1 text-[11px] text-black/70"><Maximize2 size={13} aria-hidden />Expand</span>
    </button> : <div role="img" aria-label={block.title}><p role="status" className="m-0 py-5 text-xs leading-5 text-muted-foreground">{current?.failed ? "The diagram could not be drawn. Its complete text is shown below." : "Drawing diagram…"}</p></div>}
    <button type="button" className={visualButton} aria-expanded={!!showDetails} aria-controls={`${id}-data`} disabled={current?.failed} onClick={() => setDetails(!details)}>View connections</button>
    {showDetails && <div id={`${id}-data`} className="space-y-4 text-[13px] leading-6 [overflow-wrap:anywhere]">
      <dl className="m-0 space-y-2">{block.nodes.map(node => <div key={node.id}><dt className="font-medium">{node.label}</dt>{node.detail && <dd className="m-0 text-muted-foreground">{node.detail}</dd>}</div>)}</dl>
      {!!block.edges.length && <ul className="m-0 list-disc space-y-1 pl-5">{block.edges.map((edge, index) => <li key={index}>{block.nodes.find(node => node.id === edge.from)!.label} → {block.nodes.find(node => node.id === edge.to)!.label}{edge.label ? ` (${edge.label})` : ""}</li>)}</ul>}
    </div>}
    {expanded && active && current?.url && <ExpandedDiagram key={source} title={block.title} source={source} url={current.url} width={current.width!} height={current.height!} onClose={close} />}
  </div>;
}
