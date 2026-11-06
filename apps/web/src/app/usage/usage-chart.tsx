"use client";

import type { UsageAnalyticsSeriesPoint } from "@lori-enterprise/contracts";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatEstimatedCost, formatTokens, formatUsageDate } from "@/lib/usage-format";

function uniqueTickIndexes(length: number): number[] {
  if (length <= 1) return length ? [0] : [];
  return Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map((part) => Math.round((length - 1) * part))));
}

function niceUpperBound(value: number): number {
  if (value <= 0) return 1;
  const padded = value * 1.08;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
    (candidate) => candidate >= normalized,
  ) ?? 10;
  return step * magnitude;
}

export function UsageChart({
  emptyDescription,
  emptyTitle,
  metric,
  onMetricChange,
  points,
}: {
  emptyDescription?: string;
  emptyTitle?: string;
  metric: "tokens" | "cost";
  onMetricChange(metric: "tokens" | "cost"): void;
  points: UsageAnalyticsSeriesPoint[];
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 960;
  const height = 304;
  const inset = { bottom: 34, left: 70, right: 20, top: 18 };
  const values = points.map((point) =>
    metric === "tokens" ? point.totalTokens : point.estimatedCostMicrousd,
  );
  const max = niceUpperBound(Math.max(...values, 0));
  const x = (index: number) =>
    inset.left +
    (points.length <= 1 ? 0.5 : index / (points.length - 1)) *
      (width - inset.left - inset.right);
  const y = (value: number) =>
    inset.top + (1 - value / max) * (height - inset.top - inset.bottom);
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(values[index] ?? 0)}`)
    .join(" ");
  const area = points.length > 1
    ? `${line} L ${x(points.length - 1)} ${height - inset.bottom} L ${x(0)} ${height - inset.bottom} Z`
    : "";
  const formatValue = metric === "tokens" ? formatTokens : formatEstimatedCost;
  const tickIndexes = useMemo(() => uniqueTickIndexes(points.length), [points.length]);
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeValue = activeIndex === null ? 0 : (values[activeIndex] ?? 0);

  return (
    <div>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Usage over time</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Aggregated in UTC. Select a point for exact values.
          </p>
        </div>
        <div aria-label="Chart metric" className="grid w-full grid-cols-2 rounded-md bg-muted p-0.5 sm:w-auto" role="group">
          {(["tokens", "cost"] as const).map((item) => (
            <button
              aria-pressed={metric === item}
              className={cn(
                "min-h-10 rounded-sm px-3 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 sm:min-h-7",
                metric === item
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={item}
              onClick={() => onMetricChange(item)}
              type="button"
            >
              {item === "tokens" ? "Tokens" : "Estimated cost"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-2 pb-3 pt-4 sm:px-4">
        <div
          aria-label={`${metric === "tokens" ? "Token" : "Estimated cost"} trend`}
          className="relative min-h-72 w-full overflow-hidden"
          onMouseLeave={() => setActiveIndex(null)}
          role="group"
        >
          <svg
            aria-hidden
            className="h-72 w-full"
            preserveAspectRatio="none"
            viewBox={`0 0 ${width} ${height}`}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((part) => (
              <g key={part}>
                <line
                  className="stroke-border"
                  strokeDasharray={part === 0 ? undefined : "3 5"}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  x1={inset.left}
                  x2={width - inset.right}
                  y1={y(max * part)}
                  y2={y(max * part)}
                />
                <text
                  className="fill-muted-foreground text-[11px] tabular-nums"
                  dominantBaseline="middle"
                  textAnchor="end"
                  x={inset.left - 12}
                  y={y(max * part)}
                >
                  {formatValue(max * part)}
                </text>
              </g>
            ))}
            {area ? <path className="fill-primary/10" d={area} /> : null}
            {line ? (
              <path
                className="stroke-primary [transition:stroke-dashoffset_220ms_cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none"
                d={line}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {points.length === 1 ? (
              <g data-slot="usage-chart-single-marker">
                <line
                  className="stroke-primary/30"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  x1={x(0)}
                  x2={x(0)}
                  y1={y(values[0] ?? 0)}
                  y2={height - inset.bottom}
                />
                <circle
                  className="fill-primary stroke-background"
                  cx={x(0)}
                  cy={y(values[0] ?? 0)}
                  r="6"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  className="fill-foreground text-[11px] font-semibold tabular-nums"
                  textAnchor="middle"
                  x={x(0)}
                  y={Math.max(inset.top + 10, y(values[0] ?? 0) - 13)}
                >
                  {formatValue(values[0] ?? 0)}
                </text>
              </g>
            ) : null}
            {tickIndexes.map((index) => (
              <text
                className={cn(
                  "fill-muted-foreground text-[11px] tabular-nums",
                  index !== 0 && index !== points.length - 1 && "hidden sm:block",
                )}
                key={points[index]?.label}
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                x={x(index)}
                y={height - 7}
              >
                {points[index] ? formatUsageDate(points[index]!.label) : ""}
              </text>
            ))}
          </svg>

          {points.length ? (
            <div aria-label="Trend data points" className="absolute inset-0">
              {points.map((point, index) => (
                <button
                  aria-label={`${formatUsageDate(point.label)}: ${formatValue(values[index] ?? 0)}${metric === "tokens" ? " tokens" : " estimated cost"}, ${formatTokens(point.totalTurns)} turns`}
                  className="absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[9px] border-transparent bg-primary bg-clip-content opacity-0 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100"
                  key={point.label}
                  onBlur={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  style={{ left: `${x(index) / width * 100}%`, top: `${y(values[index] ?? 0) / height * 100}%` }}
                  type="button"
                />
              ))}
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm font-medium text-foreground">{emptyTitle ?? "No usage in this range"}</p>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                  {emptyDescription ?? "Usage will appear after an enrolled Lori desktop sends its first aggregate snapshot."}
                </p>
              </div>
            </div>
          )}

          {activePoint && activeIndex !== null ? (
            <div
              aria-live="polite"
              className={cn(
                "pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md",
                x(activeIndex) / width < 0.2
                  ? "translate-x-0"
                  : x(activeIndex) / width > 0.78
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{ left: `${x(activeIndex) / width * 100}%`, top: `${Math.max(2, y(activeValue) / height * 100 - 20)}%` }}
            >
              <p className="font-medium">{formatUsageDate(activePoint.label)}</p>
              <p className="mt-1 tabular-nums text-muted-foreground">{formatValue(activeValue)}{metric === "tokens" ? " tokens" : " estimated"}</p>
              <p className="tabular-nums text-muted-foreground">{formatTokens(activePoint.totalTurns)} turns</p>
            </div>
          ) : null}
        </div>
      </div>

      <details className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5" open>
        <summary className="w-fit font-medium text-foreground hover:text-primary">
          Usage data
          <span className="ml-2 font-normal tabular-nums text-muted-foreground">
            {points.length} {points.length === 1 ? "period" : "periods"}
          </span>
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-96 text-left">
            <caption className="sr-only">Values shown in the usage trend chart.</caption>
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 font-medium" scope="col">Period</th>
                <th className="py-2 text-right font-medium" scope="col">{metric === "tokens" ? "Tokens" : "Estimated cost"}</th>
                <th className="py-2 text-right font-medium" scope="col">Turns</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr className="border-b border-border/70" key={point.label}>
                  <th className="py-2 font-normal" scope="row">{formatUsageDate(point.label)}</th>
                  <td className="py-2 text-right tabular-nums">{formatValue(values[index] ?? 0)}</td>
                  <td className="py-2 text-right tabular-nums">{formatTokens(point.totalTurns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
