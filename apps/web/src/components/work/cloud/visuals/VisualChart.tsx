"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Table2 } from "lucide-react";
import type { ChartBlock } from "@lori-enterprise/contracts";
import { VisualTable } from "./VisualTable";
import { visualButton } from "./ui";

const colors = ["text-primary", "text-success-muted-foreground", "text-warning-muted-foreground", "text-muted-foreground"];
const dashes = [undefined, "7 4", "2 4", "10 3 2 3"];
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumSignificantDigits: 3 });

/** Include zero for honest bar comparisons, including all-negative/zero data. */
export function chartDomain(values: number[]): [number, number] {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  if (min === max) return [0, 1];
  const padding = (max - min) * 0.08;
  return [min < 0 ? min - padding : 0, max > 0 ? max + padding : 0];
}

export function VisualChart({ block }: { block: ChartBlock }) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [showData, setShowData] = useState(false);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => { if (node.clientWidth) setWidth(Math.max(220, node.clientWidth)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const visible = block.series.map((series, index) => ({ ...series, index })).filter(series => !hidden.has(series.index));
  const [min, max] = chartDomain(visible.flatMap(series => series.values));
  const left = 54;
  const right = width - 12;
  const top = 12;
  const bottom = 188;
  const slot = (right - left) / block.labels.length;
  const x = (index: number) => left + slot * (index + 0.5);
  const y = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const labelEvery = Math.max(1, Math.ceil(block.labels.length / Math.max(2, Math.floor((right - left) / 80))));
  const ticks = Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);

  return <div ref={container} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label={`${block.title} series`}>
        {block.series.map((series, index) => <button key={series.name} type="button" aria-pressed={!hidden.has(index)} disabled={!hidden.has(index) && visible.length === 1}
          onClick={() => setHidden(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
          className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-foreground aria-[pressed=false]:opacity-50 disabled:cursor-default">
          <svg viewBox="0 0 20 10" width="20" height="10" className={`shrink-0 ${colors[index]}`} aria-hidden="true"><line x1="1" x2="19" y1="5" y2="5" stroke="currentColor" strokeWidth="2.5" strokeDasharray={dashes[index]} /></svg>
          <span className={`min-w-0 [overflow-wrap:anywhere] ${hidden.has(index) ? "line-through" : ""}`}>{series.name}</span>
        </button>)}
      </div>
      <button type="button" className={visualButton} aria-expanded={showData} aria-controls={`${id}-data`} onClick={() => setShowData(value => !value)}><Table2 size={13} aria-hidden="true" />{showData ? "Hide data" : "View data"}</button>
    </div>
    <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{block.yLabel}</p>
    <svg viewBox={`0 0 ${width} 232`} className="block w-full overflow-visible" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{block.title}</title>
      <desc id={`${id}-description`}>{block.chartType === "line" ? "Line" : "Bar"} chart of {block.yLabel} by {block.xLabel}. Use the inspect control or View data for exact values.</desc>
      {ticks.map((tick, index) => <g key={index} className="text-muted-foreground">
        <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className="stroke-border/60" strokeDasharray="3 4" />
        <text x={left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" fill="currentColor" fontSize="11">{compact.format(tick)}</text>
      </g>)}
      <line x1={left} x2={right} y1={y(0)} y2={y(0)} className="stroke-border" />
      <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} className="stroke-muted-foreground/40" strokeDasharray="3 3" />
      {visible.map((series, seriesIndex) => <g key={series.name} className={colors[series.index]}>
        {block.chartType === "line" ? <>
          <polyline points={series.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashes[series.index]} />
          {series.values.map((value, index) => <circle key={index} cx={x(index)} cy={y(value)} r={index === selected ? 4 : block.labels.length < 20 ? 2.5 : 0} fill="currentColor" />)}
        </> : series.values.map((value, index) => {
          const barWidth = Math.max(1, slot * 0.72 / visible.length);
          return <rect key={index} x={x(index) - slot * 0.36 + seriesIndex * barWidth} y={Math.min(y(value), y(0))} width={Math.max(0.5, barWidth - 1.5)} height={value === 0 ? 0 : Math.max(1, Math.abs(y(value) - y(0)))} rx="2" fill="currentColor" opacity={index === selected ? 1 : 0.75} />;
        })}
      </g>)}
      {block.labels.map((label, index) => <g key={index}>
        {index % labelEvery === 0 && <text x={x(index)} y={bottom + 22} textAnchor="middle" className="fill-muted-foreground" fontSize="11">{label.length > 11 ? `${label.slice(0, 10)}…` : label}</text>}
        <rect x={left + slot * index} y={top} width={slot} height={bottom - top} fill="transparent" onPointerEnter={() => setSelected(index)} onClick={() => setSelected(index)}><title>{label}: {visible.map(series => `${series.name} ${series.values[index]}`).join(", ")}</title></rect>
      </g>)}
    </svg>
    <div className="flex flex-wrap items-start gap-x-5 gap-y-2 border-t border-border/60 pt-3">
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only">Inspect {block.title}</span>
        <span className="max-w-32 [overflow-wrap:anywhere]" aria-hidden="true">{block.xLabel}</span>
        <select value={selected} onChange={event => setSelected(Number(event.target.value))} className="h-8 min-w-0 max-w-48 rounded-md border border-border bg-background px-2 text-base sm:text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {block.labels.map((label, index) => <option key={index} value={index}>{label}</option>)}
        </select>
      </label>
      <dl className="m-0 flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-2">
        {visible.map(series => <div key={series.name} className="min-w-0"><dt className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{series.name}</dt><dd className="m-0 text-sm font-medium text-foreground tabular-nums">{series.values[selected]!.toLocaleString(undefined, { maximumSignificantDigits: 12 })}</dd></div>)}
      </dl>
    </div>
    <div id={`${id}-data`} hidden={!showData} className="pt-2">{showData && <VisualTable block={{ type: "table", title: `${block.title} data`, columns: [block.xLabel, ...block.series.map(series => `${series.name} (${block.yLabel})`)], rows: block.labels.map((label, index) => [label, ...block.series.map(series => series.values[index]!)]) }} />}</div>
  </div>;
}
