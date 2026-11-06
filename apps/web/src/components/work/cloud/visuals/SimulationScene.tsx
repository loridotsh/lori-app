"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { SimulationView } from "@lori-enterprise/contracts";

const colors = ["text-primary", "text-success-muted-foreground", "text-warning-muted-foreground", "text-muted-foreground"];
const standard = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 });
const scientific = new Intl.NumberFormat(undefined, { notation: "scientific", maximumSignificantDigits: 6 });
const number = (value: number) => (Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 0.0001) ? scientific : standard).format(value);
const fraction = (value: number, min: number, max: number) => Math.max(0, Math.min(1, (value - min) / (max - min)));
export interface ScenePosition { label: string; x: number; y?: number }

export function SimulationScene({ view, positions }: { view: SimulationView; positions: ScenePosition[] }) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => { if (node.clientWidth) setWidth(Math.max(240, node.clientWidth)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  if (view.type === "track") return <div ref={container} className="space-y-5 py-2">
    {positions.map((item, index) => <figure key={item.label} className="m-0 min-w-0">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]"><span className={`${colors[index]} font-medium`}>{item.label}</span></span>
        <span className="min-w-0 font-medium text-foreground tabular-nums [overflow-wrap:anywhere]">{number(item.x)}{view.unit ? ` ${view.unit}` : ""}{(item.x < view.min || item.x > view.max) && " · Outside display range"}</span>
      </figcaption>
      <div className="relative mx-2 flex h-8 items-center" role="img" aria-label={`${item.label}: ${number(item.x)} ${view.unit ?? ""} on ${view.label}`}>
        <div className="h-0.5 w-full bg-border" />
        <div className={`absolute left-0 h-0.5 bg-current ${colors[index]}`} style={{ width: `${fraction(item.x, view.min, view.max) * 100}%` }} />
        <span className={`absolute size-4 -translate-x-1/2 rounded-full bg-current outline-2 outline-background ${colors[index]}`} style={{ left: `${fraction(item.x, view.min, view.max) * 100}%` }} />
      </div>
    </figure>)}
    <div className="mx-2 flex justify-between gap-2 text-xs text-muted-foreground tabular-nums" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => <span key={i}>{number(view.min + (view.max - view.min) * i / 4)}</span>)}
    </div>
    <p className="m-0 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.label}{view.unit ? ` (${view.unit})` : ""}</p>
  </div>;
  const left = 48, right = width - 16, top = 12, bottom = 200;
  const x = (value: number) => left + fraction(value, view.xMin, view.xMax) * (right - left);
  const y = (value: number) => bottom - fraction(value, view.yMin, view.yMax) * (bottom - top);
  return <div ref={container} className="space-y-3">
    <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.yLabel}</p>
    <svg viewBox={`0 0 ${width} 230`} className="block w-full" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{view.xLabel} and {view.yLabel}</title>
      <desc id={`${id}-description`}>{positions.map(item => `${item.label}: ${number(item.x)}, ${number(item.y ?? 0)}`).join("; ")}. Exact coordinates are listed below.</desc>
      {Array.from({ length: 5 }, (_, i) => <g key={i} className="text-muted-foreground">
        <line x1={left} x2={right} y1={top + (bottom-top)*i/4} y2={top+(bottom-top)*i/4} className="stroke-border/60" strokeDasharray="3 4" />
        <text x={left-8} y={top+(bottom-top)*i/4} dominantBaseline="middle" textAnchor="end" fill="currentColor" fontSize="11">{number(view.yMax-(view.yMax-view.yMin)*i/4)}</text>
        <text x={left+(right-left)*i/4} y={bottom+22} textAnchor="middle" fill="currentColor" fontSize="11">{number(view.xMin+(view.xMax-view.xMin)*i/4)}</text>
      </g>)}
      <line x1={left} x2={right} y1={y(0)} y2={y(0)} className="stroke-border" />
      <line x1={x(0)} x2={x(0)} y1={top} y2={bottom} className="stroke-border" />
      {positions.map((item, index) => <g key={item.label} className={colors[index]}>
        {index === 0 ? <circle cx={x(item.x)} cy={y(item.y ?? 0)} r="6" fill="currentColor" />
          : index === 1 ? <rect x={x(item.x)-5} y={y(item.y ?? 0)-5} width="10" height="10" fill="currentColor" />
          : index === 2 ? <polygon points={`${x(item.x)},${y(item.y ?? 0)-7} ${x(item.x)-6},${y(item.y ?? 0)+5} ${x(item.x)+6},${y(item.y ?? 0)+5}`} fill="currentColor" />
          : <polygon points={`${x(item.x)},${y(item.y ?? 0)-7} ${x(item.x)+6},${y(item.y ?? 0)} ${x(item.x)},${y(item.y ?? 0)+7} ${x(item.x)-6},${y(item.y ?? 0)}`} fill="currentColor" />}
      </g>)}
    </svg>
    <p className="m-0 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.xLabel}</p>
    <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 text-xs">
      {positions.map((item, index) => <div key={item.label} className="min-w-0">
        <dt className={`font-medium ${colors[index]} [overflow-wrap:anywhere]`}>{item.label}</dt>
        <dd className="m-0 mt-1 text-foreground tabular-nums [overflow-wrap:anywhere]">{number(item.x)}, {number(item.y ?? 0)}{(item.x < view.xMin || item.x > view.xMax || (item.y ?? 0) < view.yMin || (item.y ?? 0) > view.yMax) && " · Outside display range"}</dd>
      </div>)}
    </dl>
  </div>;
}
