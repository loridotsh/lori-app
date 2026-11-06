"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, ImageDown, Minus, Plus, Scan, X } from "lucide-react";
import type { MindmapBlock } from "@lori-enterprise/contracts";
import { initialCollapsed, layoutMindmap, mindmapChildren, mindmapRoot, mindmapToggleOffset, mindmapToggleSize } from "./mindmapLayout";
import { mindmapPng } from "./mindmapImage";
import { exportImage } from "./exportVisual";
import { visualIconButton } from "./ui";

type View = { x: number; y: number; scale: number };
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const tone = [
  "border-primary/40 bg-primary/10 text-[14px] font-semibold",
  "border-border bg-secondary text-[13px] font-medium",
  "border-success/30 bg-success/10 text-[13px] font-medium",
];
const INLINE_MIN = 240;
const INLINE_MAX = 480;
const INLINE_PAD = 64;

export function VisualMindmap({ block, stage = false, canExport = false }: { block: MindmapBlock; stage?: boolean; canExport?: boolean }) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(block));
  const layout = useMemo(() => layoutMindmap(block, collapsed), [block, collapsed]);
  const children = useMemo(() => mindmapChildren(block), [block]);
  const root = useMemo(() => mindmapRoot(block), [block]);
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"idle" | "saving" | "failed">("idle");
  const allExpanded = collapsed.size === 0;

  const fit = useCallback((): View => {
    const box = viewport.current;
    const width = box?.clientWidth ?? 0;
    const height = box?.clientHeight ?? 0;
    if (!width || !height) return { x: 0, y: 0, scale: 1 };
    const usable = Math.max(120, width - 56);
    const scale = clamp(Math.min(usable / layout.width, height / layout.height), 0.35, stage ? 1.15 : 1);
    return { x: (usable - layout.width * scale) / 2, y: (height - layout.height * scale) / 2, scale };
  }, [layout, stage]);

  // Inline maps size to their content so a short map leaves no empty band in the conversation.
  useLayoutEffect(() => {
    const element = frame.current;
    if (stage || !element) return;
    setFrameWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFrameWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);

  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    const node = kept && layout.nodes.find(item => item.id === kept.id);
    if (node) setView(current => ({ ...current, x: kept.x - node.x * current.scale, y: kept.y - node.y * current.scale }));
    else if (!touched.current) setView(fit());
  }, [layout, fit]);

  useEffect(() => {
    const box = viewport.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!touched.current) setView(fit()); });
    observer.observe(box);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    touched.current = true;
    setView(current => {
      const box = viewport.current;
      const x = cx ?? (box?.clientWidth ?? 0) / 2;
      const y = cy ?? (box?.clientHeight ?? 0) / 2;
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      return { scale, x: x - (x - current.x) * (scale / current.scale), y: y - (y - current.y) * (scale / current.scale) };
    });
  }, []);

  useEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = box.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else if (stage) {
        event.preventDefault();
        touched.current = true;
        setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
      }
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, [stage, zoomAt]);

  const toggle = (id: string) => {
    const node = layout.nodes.find(item => item.id === id);
    if (node) anchor.current = { id, x: viewRef.current.x + node.x * viewRef.current.scale, y: viewRef.current.y + node.y * viewRef.current.scale };
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const setAll = (expand: boolean) => {
    touched.current = false;
    setSelected(null);
    setCollapsed(expand ? new Set() : new Set(block.nodes.filter(node => node.id !== root.id && children.has(node.id)).map(node => node.id)));
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 3) return;
    current.moved = true;
    touched.current = true;
    current.x = event.clientX; current.y = event.clientY;
    setView(previous => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) {
      if (!drag.current.moved) setSelected(null);
      drag.current = null;
    }
  };

  const download = async () => {
    if (!canExport) return;
    setExporting("saving");
    try {
      await exportImage(block.title, await mindmapPng(layout, block.title));
      setExporting("idle");
    } catch { setExporting("failed"); }
  };

  const focusNode = selected ? block.nodes.find(node => node.id === selected) : undefined;
  const percent = Math.round(view.scale * 100);

  const inlineHeight = frameWidth ? clamp(Math.round(layout.height * clamp((frameWidth - 56) / layout.width, 0.35, 1) + INLINE_PAD), INLINE_MIN, INLINE_MAX) : 360;

  return <div ref={frame} style={stage ? undefined : { height: inlineHeight }} className={`relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background ${stage ? "h-full min-h-[360px]" : ""}`}>
    <div
      ref={viewport}
      role="application"
      aria-roledescription="mind map"
      aria-label={`${block.title}. Drag to pan, use plus and minus to zoom, 0 to fit.`}
      tabIndex={0}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const pan = (dx: number, dy: number) => { touched.current = true; setView(current => ({ ...current, x: current.x + dx, y: current.y + dy })); };
        const actions: Record<string, () => void> = {
          "+": () => zoomAt(1.2), "=": () => zoomAt(1.2), "-": () => zoomAt(1 / 1.2), "0": () => { touched.current = false; setView(fit()); },
          ArrowLeft: () => pan(48, 0), ArrowRight: () => pan(-48, 0), ArrowUp: () => pan(0, 48), ArrowDown: () => pan(0, -48),
        };
        const action = actions[event.key];
        if (action) { event.preventDefault(); action(); }
      }}
    >
      <div className="absolute top-0 left-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg aria-hidden="true" width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible">
          {layout.edges.map(edge => <path key={`${edge.from}-${edge.to}`} d={edge.path} fill="none" strokeWidth={1.5} className={edge.depth === 0 ? "stroke-foreground/30" : "stroke-foreground/20"} />)}
        </svg>
        <ul aria-label={block.title} className="m-0 list-none p-0">
          {layout.nodes.map(node => <li key={node.id} className="absolute motion-safe:animate-[work-visual-fade_160ms_ease-out]" style={{ left: node.x, top: node.y }}>
            <button
              type="button"
              aria-pressed={selected === node.id}
              title={node.detail ?? node.label}
              onClick={() => setSelected(current => current === node.id ? null : node.id)}
              className={`box-border block rounded-lg border px-3.5 py-[9px] text-left leading-[19px] text-foreground outline-none transition-[background-color,box-shadow] duration-150 hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${tone[Math.min(node.depth, 2)]} ${selected === node.id ? "ring-2 ring-ring" : ""}`}
              style={{ width: node.width, height: node.height }}
            >{node.lines.map((line, index) => <span key={index} className="block whitespace-nowrap">{line}</span>)}</button>
            {node.childCount > 0 && <button
              type="button"
              aria-expanded={node.expanded}
              aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.label} (${node.childCount} ${node.childCount === 1 ? "subtopic" : "subtopics"})`}
              title={node.expanded ? "Collapse" : `Show ${node.childCount} ${node.childCount === 1 ? "subtopic" : "subtopics"}`}
              onClick={() => toggle(node.id)}
              className="absolute inline-flex items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold text-muted-foreground outline-none transition-colors duration-150 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              style={{ left: node.width + mindmapToggleOffset, top: node.height / 2 - mindmapToggleSize / 2, width: mindmapToggleSize, height: mindmapToggleSize }}
            >{node.expanded ? <ChevronLeft size={13} aria-hidden /> : <><span className="sr-only">Show</span><ChevronRight size={13} aria-hidden /></>}</button>}
          </li>)}
        </ul>
      </div>
    </div>

    {focusNode && <div role="region" aria-label={`About ${focusNode.label}`} className="absolute bottom-3 left-3 z-10 w-[min(340px,calc(100%-5.5rem))] rounded-lg border border-border bg-popover px-3.5 py-3 text-[13px] leading-5 text-popover-foreground shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 font-semibold [overflow-wrap:anywhere]">{focusNode.label}</h4>
        <button type="button" className={`${visualIconButton} -mt-1 -mr-1.5 size-7`} aria-label="Close topic details" onClick={() => setSelected(null)}><X size={14} aria-hidden /></button>
      </div>
      {focusNode.detail ? <p className="mt-1 mb-0 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{focusNode.detail}</p> : <p className="mt-1 mb-0 text-muted-foreground">No further detail for this topic.</p>}
      {children.has(focusNode.id) && <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggle(focusNode.id)}>{collapsed.has(focusNode.id) ? `Show ${children.get(focusNode.id)!.length} subtopics` : "Hide subtopics"}</button>}
    </div>}

    <div className="absolute right-3 bottom-3 z-10 flex flex-col items-center gap-1.5">
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        <button type="button" className={`${visualIconButton} rounded-none`} aria-label={allExpanded ? "Collapse all" : "Expand all"} title={allExpanded ? "Collapse all" : "Expand all"} onClick={() => setAll(!allExpanded)}>{allExpanded ? <ChevronsDownUp size={15} aria-hidden /> : <ChevronsUpDown size={15} aria-hidden />}</button>
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        <button type="button" className={`${visualIconButton} rounded-none`} aria-label="Zoom in" title="Zoom in" disabled={view.scale >= MAX_SCALE} onClick={() => zoomAt(1.2)}><Plus size={15} aria-hidden /></button>
        <button type="button" className={`${visualIconButton} rounded-none border-y border-border`} aria-label="Fit to view" title={`Fit to view (${percent}%)`} onClick={() => { touched.current = false; setView(fit()); }}><Scan size={14} aria-hidden /></button>
        <button type="button" className={`${visualIconButton} rounded-none`} aria-label="Zoom out" title="Zoom out" disabled={view.scale <= MIN_SCALE} onClick={() => zoomAt(1 / 1.2)}><Minus size={15} aria-hidden /></button>
      </div>
      {canExport && <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        <button type="button" className={`${visualIconButton} rounded-none`} aria-label="Download image" title="Download as PNG" disabled={exporting === "saving"} onClick={() => void download()}><ImageDown size={15} aria-hidden /></button>
      </div>}
    </div>
    <p className="pointer-events-none absolute top-2.5 right-3 m-0 text-[11px] tabular-nums text-muted-foreground" aria-live="polite">{percent}%</p>
    {exporting === "failed" && <p role="alert" className="absolute top-2.5 left-3 m-0 rounded-md bg-card px-2 py-1 text-xs text-destructive">Could not save the image. Try again.</p>}
  </div>;
}
