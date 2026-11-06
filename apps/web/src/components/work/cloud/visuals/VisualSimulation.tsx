"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { CalculatorInput, SimulationBlock } from "@lori-enterprise/contracts";
import { calculate, compileExpression } from "@lori-enterprise/contracts";
import { SimulationScene, type ScenePosition } from "./SimulationScene";
import { useSimulationClock, useSimulationVisibility } from "./useSimulationClock";
import { visualButton } from "./ui";

function SimulationControl({ input, value, onChange, continuous = false }: { input: CalculatorInput; value: number; onChange: (value: number) => void; continuous?: boolean }) {
  const id = useId();
  return <div className="min-w-0">
    <div className="mb-2 flex items-start justify-between gap-3 text-[13px] leading-5">
      <label htmlFor={id} className="min-w-0 [overflow-wrap:anywhere]">{input.label}</label>
      <output htmlFor={id} aria-live="off" className="min-w-0 max-w-[65%] shrink-0 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{value.toLocaleString(undefined, { maximumFractionDigits: 6 })}{input.unit && <span className="ml-1 font-normal text-muted-foreground">{input.unit}</span>}</output>
    </div>
    <input id={id} type="range" min={input.min} max={input.max} step={continuous ? "any" : input.step} value={value}
      onChange={event => {
        const next = Number(event.target.value);
        onChange(continuous ? Math.max(input.min, Math.min(input.max, Number((input.min + Math.round((next-input.min)/input.step)*input.step).toFixed(6)))) : next);
      }}
      onKeyDown={event => {
        if (!continuous || event.altKey || event.metaKey || event.ctrlKey) return;
        const direction = ["ArrowRight","ArrowUp","PageUp"].includes(event.key) ? 1 : ["ArrowLeft","ArrowDown","PageDown"].includes(event.key) ? -1 : 0;
        if (!direction && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        onChange(event.key === "Home" ? input.min : event.key === "End" ? input.max : Math.max(input.min,Math.min(input.max,Number((value + direction * input.step * (event.key.startsWith("Page") ? 10 : 1)).toFixed(6)))));
      }} aria-valuetext={`${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${input.unit ?? ""}`}
      className="h-6 w-full cursor-pointer accent-primary outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring" />
  </div>;
}

export function VisualSimulation({ block, active = true }: { block: SimulationBlock; active?: boolean }) {
  const id = useId();
  const element = useRef<HTMLDivElement>(null);
  const [inputs, setInputs] = useState(() => block.inputs.map(input => input.value));
  const enabled = useSimulationVisibility(element, active);
  const clock = useSimulationClock(block.timeline, enabled);
  const compiled = useMemo(() => ({
    outputs: block.outputs.map(output => compileExpression(output.expression)),
    scene: block.view.items.map(item => "expression" in item ? { x: compileExpression(item.expression), y: null }
      : { x: compileExpression(item.x), y: compileExpression(item.y) }),
  }), [block]);
  const values = new Map(block.inputs.map((input, index) => [input.id, inputs[index]!]));
  values.set(block.timeline.id, clock.value);
  const outputs = compiled.outputs.map(expression => expression ? calculate(expression, values) : null);
  const positions = compiled.scene.map((expressions, index) => ({ label: block.view.items[index]!.label,
    x: expressions.x ? calculate(expressions.x, values) : null,
    y: expressions.y ? calculate(expressions.y, values) : undefined,
  }));
  const valid = outputs.every(value => value !== null) && positions.every(item => item.x !== null && item.y !== null);
  useEffect(() => { if (!valid) clock.pause(); }, [valid, clock.pause]);
  return <div ref={element} className="space-y-5" data-simulation-state={clock.playing ? "playing" : "paused"}>
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 @min-[460px]:grid-cols-2">
      {block.inputs.map((input, index) => <SimulationControl key={input.id} input={input} value={inputs[index]!} onChange={next => {
        if (Number.isFinite(next) && next >= input.min && next <= input.max) setInputs(current => current.map((value, i) => i === index ? next : value));
      }} />)}
      <SimulationControl input={block.timeline} value={clock.value} onChange={clock.seek} continuous />
    </div>
    {valid ? <SimulationScene view={block.view} positions={positions as ScenePosition[]} />
      : <p role="status" className="m-0 py-4 text-[13px] leading-6 text-muted-foreground">This combination has an undefined result. Adjust the controls or reset playback.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={clock.playing ? clock.pause : clock.play} disabled={!valid || !enabled}
        aria-label={`${clock.playing ? "Pause" : "Play"} ${block.title}`}
        className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40">
        {clock.playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{clock.playing ? "Pause" : "Play"}
      </button>
      <button type="button" onClick={clock.reset} className={visualButton} aria-label={`Reset ${block.title}`}><RotateCcw size={13} aria-hidden="true" />Reset</button>
      <span className="ml-1 text-xs text-muted-foreground" role="status">{clock.value >= block.timeline.max ? "Playback complete" : clock.playing ? "Playing" : "Paused"}</span>
    </div>
    <dl className="m-0 flex flex-wrap gap-x-7 gap-y-3">
      {block.outputs.map((output, index) => <div key={index} className="min-w-0">
        <dt id={`${id}-${index}`} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{output.label}</dt>
        <dd className="m-0 mt-1"><output aria-labelledby={`${id}-${index}`} aria-live="off" className="text-base font-medium tabular-nums [overflow-wrap:anywhere]">
          {outputs[index] === null ? "Undefined" : outputs[index]!.toLocaleString(undefined, { maximumFractionDigits: output.precision ?? 2 })}{output.unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{output.unit}</span>}
        </output></dd>
      </div>)}
    </dl>
    {block.note && <p className="m-0 whitespace-pre-wrap text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{block.note}</p>}
  </div>;
}
