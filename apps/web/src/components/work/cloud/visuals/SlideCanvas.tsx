"use client";

import type { Slide } from "@lori-enterprise/contracts";

const seriesColors = ["var(--slide-accent)", "var(--slide-accent-2)", "var(--slide-accent-3)"];

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${+(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${+(value / 1e3).toFixed(1)}K`;
  return `${+value.toFixed(2)}`;
}

function SlideChart({ chart }: { chart: NonNullable<Slide["chart"]> }) {
  const width = 1000;
  const height = 420;
  const left = 64;
  const bottom = 46;
  const top = 26;
  const values = chart.series.flatMap(series => series.values);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const plot = height - bottom - top;
  const y = (value: number) => top + (max - value) / span * plot;
  const band = (width - left) / chart.labels.length;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(step => min + span * step);
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full overflow-visible" role="img" aria-label={`${chart.chartType === "bar" ? "Bar" : "Line"} chart${chart.unit ? ` in ${chart.unit}` : ""}: ${chart.series.map(series => `${series.name} ${series.values.map((value, i) => `${chart.labels[i]} ${value}`).join(", ")}`).join("; ")}`}>
    {ticks.map(tick => <g key={tick}>
      <line x1={left} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--slide-rule)" strokeWidth={tick === 0 ? 2 : 1} />
      <text x={left - 12} y={y(tick) + 7} textAnchor="end" fontSize={20} fill="var(--slide-muted)">{compact(tick)}</text>
    </g>)}
    {chart.chartType === "bar"
      ? chart.series.map((series, s) => series.values.map((value, i) => {
        const group = band * 0.64;
        const bar = group / chart.series.length;
        const x = left + band * i + (band - group) / 2 + bar * s;
        const y0 = y(Math.max(0, value));
        return <g key={`${s}-${i}`}>
          <rect x={x + 3} y={y0} width={Math.max(2, bar - 6)} height={Math.max(1, Math.abs(y(value) - y(0)))} rx={4} fill={seriesColors[s]} />
          <text x={x + bar / 2} y={y0 - 9} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--slide-ink)">{compact(value)}</text>
        </g>;
      }))
      : chart.series.map((series, s) => <g key={s}>
        <polyline points={series.values.map((value, i) => `${left + band * i + band / 2},${y(value)}`).join(" ")} fill="none" stroke={seriesColors[s]} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
        {series.values.map((value, i) => <g key={i}>
          <circle cx={left + band * i + band / 2} cy={y(value)} r={8} fill="var(--slide-paper)" stroke={seriesColors[s]} strokeWidth={4} />
          {s === 0 && <text x={left + band * i + band / 2} y={y(value) - 18} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--slide-ink)">{compact(value)}</text>}
        </g>)}
      </g>)}
    {chart.labels.map((label, i) => <text key={i} x={left + band * i + band / 2} y={height - 12} textAnchor="middle" fontSize={21} fill="var(--slide-muted)">{label}</text>)}
  </svg>;
}

export function SlideCanvas({ slide, index, total, deck }: { slide: Slide; index: number; total: number; deck: string }) {
  const kicker = slide.kicker && <p className="m-0 text-[1.35cqw] font-semibold tracking-[0.14em] text-[var(--slide-accent)] uppercase">{slide.kicker}</p>;
  const headline = <h3 className="m-0 text-[3.5cqw] leading-[1.12] font-semibold tracking-[-0.02em] text-balance [overflow-wrap:anywhere]">{slide.title}</h3>;
  const subtitle = slide.subtitle && <p className="m-0 mt-[1.4cqw] max-w-[78%] text-[1.9cqw] leading-[1.45] text-[var(--slide-muted)] text-pretty [overflow-wrap:anywhere]">{slide.subtitle}</p>;
  let body;
  switch (slide.layout) {
    case "title":
      body = <div className="flex h-full flex-col justify-end pb-[5cqw]">
        <span className="mb-[2.4cqw] block h-[0.5cqw] w-[7cqw] rounded-full bg-[var(--slide-accent)]" />
        {kicker}
        <h3 className="m-0 mt-[1.2cqw] max-w-[86%] text-[5.6cqw] leading-[1.04] font-semibold tracking-[-0.03em] text-balance [overflow-wrap:anywhere]">{slide.title}</h3>
        {subtitle}
      </div>;
      break;
    case "section":
      body = <div className="flex h-full flex-col justify-center">
        <p className="m-0 text-[7cqw] leading-none font-semibold tracking-[-0.04em] text-[var(--slide-accent-2)] tabular-nums">{String(index + 1).padStart(2, "0")}</p>
        <div className="mt-[2cqw] border-t-[0.2cqw] border-[var(--slide-ink)] pt-[2cqw]">{kicker}<h3 className="m-0 mt-[0.6cqw] max-w-[80%] text-[4.4cqw] leading-[1.08] font-semibold tracking-[-0.025em] text-balance [overflow-wrap:anywhere]">{slide.title}</h3>{subtitle}</div>
      </div>;
      break;
    case "statement":
      body = <div className="flex h-full flex-col justify-center">
        <span aria-hidden className="block text-[9cqw] leading-[0.6] font-semibold text-[var(--slide-accent)]">“</span>
        <h3 className="m-0 mt-[1cqw] max-w-[88%] text-[4.2cqw] leading-[1.18] font-medium tracking-[-0.02em] text-balance [overflow-wrap:anywhere]">{slide.title}</h3>
        {slide.subtitle && <p className="m-0 mt-[2.4cqw] text-[1.6cqw] font-medium tracking-[0.04em] text-[var(--slide-muted)]">{slide.subtitle}</p>}
      </div>;
      break;
    case "closing":
      body = <div className="flex h-full flex-col items-center justify-center text-center">
        {kicker}
        <h3 className="m-0 mt-[1cqw] max-w-[80%] text-[4.8cqw] leading-[1.08] font-semibold tracking-[-0.03em] text-balance [overflow-wrap:anywhere]">{slide.title}</h3>
        {slide.subtitle && <p className="m-0 mt-[1.6cqw] max-w-[70%] text-[1.9cqw] leading-[1.45] text-[var(--slide-muted)]">{slide.subtitle}</p>}
        <span className="mt-[3cqw] block h-[0.5cqw] w-[6cqw] rounded-full bg-[var(--slide-accent)]" />
      </div>;
      break;
    case "bullets":
      body = <div className="flex h-full flex-col">
        {kicker}{headline}{subtitle}
        <ul className="m-0 mt-[3.2cqw] flex list-none flex-col gap-[1.9cqw] p-0">
          {slide.bullets!.map((item, i) => <li key={i} className="flex gap-[1.6cqw] text-[2.15cqw] leading-[1.38] [overflow-wrap:anywhere]">
            <span aria-hidden className="mt-[0.95cqw] block size-[0.85cqw] shrink-0 rounded-[0.2cqw] bg-[var(--slide-accent)]" />
            <span className="min-w-0">{item}</span>
          </li>)}
        </ul>
      </div>;
      break;
    case "stats":
      body = <div className="flex h-full flex-col">
        {kicker}{headline}{subtitle}
        <div className="mt-auto mb-[1cqw] grid gap-[2.4cqw]" style={{ gridTemplateColumns: `repeat(${slide.stats!.length}, minmax(0, 1fr))` }}>
          {slide.stats!.map((item, i) => <div key={i} className="min-w-0 border-t-[0.25cqw] border-[var(--slide-accent)] pt-[1.6cqw]">
            <p className="m-0 text-[5.4cqw] leading-none font-semibold tracking-[-0.035em] tabular-nums [overflow-wrap:anywhere]">{item.value}</p>
            <p className="m-0 mt-[1.2cqw] text-[1.75cqw] leading-[1.3] font-medium [overflow-wrap:anywhere]">{item.label}</p>
            {item.detail && <p className="m-0 mt-[0.6cqw] text-[1.4cqw] leading-[1.4] text-[var(--slide-muted)] [overflow-wrap:anywhere]">{item.detail}</p>}
          </div>)}
        </div>
      </div>;
      break;
    case "columns":
      body = <div className="flex h-full flex-col">
        {kicker}{headline}{subtitle}
        <div className="mt-[5cqw] grid gap-[3cqw]" style={{ gridTemplateColumns: `repeat(${slide.columns!.length}, minmax(0, 1fr))` }}>
          {slide.columns!.map((item, i) => <div key={i} className="min-w-0">
            <p className="m-0 text-[1.3cqw] font-semibold tracking-[0.12em] text-[var(--slide-accent)] tabular-nums">{String(i + 1).padStart(2, "0")}</p>
            <p className="m-0 mt-[0.8cqw] border-t border-[var(--slide-rule)] pt-[1.2cqw] text-[2.1cqw] leading-[1.25] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{item.heading}</p>
            <p className="m-0 mt-[1cqw] text-[1.6cqw] leading-[1.5] text-[var(--slide-muted)] [overflow-wrap:anywhere]">{item.text}</p>
          </div>)}
        </div>
      </div>;
      break;
    case "chart":
      body = <div className="flex h-full flex-col">
        {kicker}{headline}{subtitle}
        {(slide.chart!.series.length > 1 || slide.chart!.unit) && <div className="mt-[1.6cqw] flex flex-wrap items-center gap-x-[2.4cqw] gap-y-[0.6cqw] text-[1.35cqw] text-[var(--slide-muted)]">
          {slide.chart!.series.length > 1 && slide.chart!.series.map((series, s) => <span key={s} className="inline-flex items-center gap-[0.7cqw]"><span className="block size-[1.1cqw] rounded-[0.25cqw]" style={{ background: seriesColors[s] }} />{series.name}</span>)}
          {slide.chart!.unit && <span>{slide.chart!.unit}</span>}
        </div>}
        <div className="mt-[2cqw] min-h-0 flex-1"><SlideChart chart={slide.chart!} /></div>
      </div>;
      break;
  }
  return <div className="work-slide relative aspect-video w-full overflow-hidden text-left select-text">
    <div className="absolute inset-x-[6.5cqw] top-[5.5cqw] bottom-[7.5cqw]">{body}</div>
    <div className="absolute inset-x-[6.5cqw] bottom-[2.6cqw] flex items-center justify-between gap-[2cqw] border-t border-[var(--slide-rule)] pt-[1.2cqw] text-[1.15cqw] text-[var(--slide-muted)]">
      <span className="min-w-0 truncate">{deck}</span>
      <span className="shrink-0 tabular-nums">{index + 1} / {total}</span>
    </div>
  </div>;
}
