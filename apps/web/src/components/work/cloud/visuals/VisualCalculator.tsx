"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useId, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { CalculatorBlock } from "@lori-enterprise/contracts";
import { calculate } from "@lori-enterprise/contracts";
import { visualButton } from "./ui";

export function VisualCalculator({ block }: { block: CalculatorBlock }) {
  const id = useId();
  const defaults = () => block.inputs.map(input => String(input.value));
  const [raw, setRaw] = useState(defaults);
  const inputs = useMemo(() => block.inputs.map((input, index) => {
    const value = raw[index]!.trim() ? Number(raw[index]) : NaN;
    return { ...input, current: value, valid: Number.isFinite(value) && value >= input.min && value <= input.max };
  }), [block.inputs, raw]);
  const values = new Map(inputs.filter(input => input.valid).map(input => [input.id, input.current]));
  const valid = inputs.every(input => input.valid);
  const changed = inputs.some(input => !input.valid || input.current !== input.value);
  const update = (index: number, value: string) => setRaw(current => current.map((old, i) => i === index ? value : old));

  return <div className="space-y-5">
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 @min-[460px]:grid-cols-2">
      {inputs.map((input, index) => <div key={input.id} className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor={`${id}-${input.id}`} className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">{input.label}{input.unit && <span className="ml-1 font-normal text-muted-foreground">({input.unit})</span>}</label>
          <input id={`${id}-${input.id}`} type="number" min={input.min} max={input.max} step="any" value={raw[index]}
            onChange={event => update(index, event.target.value)} aria-invalid={!input.valid} aria-describedby={!input.valid ? `${id}-${input.id}-error` : undefined}
            className="h-8 w-28 min-w-0 shrink-0 rounded-md border border-border bg-background px-2 text-right text-base sm:text-xs text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive" />
        </div>
        <input type="range" aria-label={`Adjust ${input.label}`} min={input.min} max={input.max} step={input.step}
          value={input.valid ? input.current : input.value} onChange={event => update(index, event.target.value)}
          className="h-6 w-full cursor-pointer accent-primary outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring" />
        <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums"><span>{input.min.toLocaleString()}</span><span>{input.max.toLocaleString()}</span></div>
        {!input.valid && <p id={`${id}-${input.id}-error`} className="mt-1 text-xs text-destructive">Enter a number from {input.min.toLocaleString()} to {input.max.toLocaleString()}.</p>}
      </div>)}
    </div>
    <div className="grid grid-cols-1 gap-4 border-y border-border/70 py-4 @min-[360px]:grid-cols-2" aria-live="polite" aria-atomic="true">
      {block.outputs.map((output, index) => {
        const value = valid ? calculate(output.expression, values) : null;
        return <div key={index} className="min-w-0">
          <div id={`${id}-output-${index}`} className="mb-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{output.label}</div>
          <output aria-labelledby={`${id}-output-${index}`} className="block text-xl font-medium tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]">
            {value === null ? <span className="text-sm font-normal text-muted-foreground">{valid ? "Undefined for these inputs" : "Check inputs"}</span> : <>{value.toLocaleString(undefined, { maximumFractionDigits: output.precision ?? 2 })}{output.unit && <span className="ml-1.5 text-xs font-normal tracking-normal text-muted-foreground">{output.unit}</span>}</>}
          </output>
        </div>;
      })}
    </div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="m-0 min-w-0 flex-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{block.note ?? "Adjust the inputs to explore this calculation."}</p>
      <button type="button" className={visualButton} disabled={!changed} onClick={() => setRaw(defaults())} aria-label={`Reset ${block.title}`}><RotateCcw size={13} aria-hidden="true" />Reset</button>
    </div>
  </div>;
}
