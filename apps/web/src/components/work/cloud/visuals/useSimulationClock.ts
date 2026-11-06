"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SimulationBlock } from "@lori-enterprise/contracts";

export function useSimulationVisibility(element: RefObject<HTMLElement | null>, active: boolean) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === node);
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return active && visible && inView;
}

/** One clock for the slider, scene, and outputs. Never count animation frames as time. */
export function useSimulationClock(timeline: SimulationBlock["timeline"], enabled: boolean) {
  const [value, setValue] = useState(timeline.value);
  const [playing, setPlaying] = useState(false);
  const current = useRef(value);
  const running = useRef(false);
  const pause = useCallback(() => { running.current = false; setPlaying(false); }, []);
  const seek = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    pause();
    current.current = Math.max(timeline.min, Math.min(timeline.max, next));
    setValue(current.current);
  }, [pause, timeline.min, timeline.max]);
  const reset = useCallback(() => seek(timeline.value), [seek, timeline.value]);
  const play = useCallback(() => {
    if (!enabled || document.hidden || typeof requestAnimationFrame !== "function") return;
    if (current.current >= timeline.max) { current.current = timeline.min; setValue(timeline.min); }
    running.current = true;
    setPlaying(true);
  }, [enabled, timeline.max, timeline.min]);

  useEffect(() => {
    if (!enabled) { pause(); return; }
    if (!playing) return;
    let cancelled = false;
    let frame: number | null = null;
    let previous: number | null = null;
    const tick = (timestamp: number) => {
      if (cancelled || !running.current) return;
      if (document.hidden) { pause(); return; }
      if (previous !== null) {
        current.current = Math.min(timeline.max, current.current + Math.max(0, timestamp - previous) / 1000 * timeline.rate);
        setValue(current.current);
      }
      previous = timestamp;
      if (current.current >= timeline.max) pause();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelled = true; if (frame !== null) cancelAnimationFrame(frame); };
  }, [enabled, playing, pause, timeline.max, timeline.rate]);
  return { value, playing: playing && enabled, play, pause, seek, reset };
}
