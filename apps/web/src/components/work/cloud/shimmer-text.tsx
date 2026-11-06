"use client";

import type { ComponentPropsWithoutRef, CSSProperties } from "react";

/** One sweep plus its pause. The CSS reads this through `--shimmer-dur`, so it is defined once. */
export const SHIMMER_MS = 1900;

/**
 * Every shimmer on the page starts from the same wall-clock phase, so a
 * running tool, its group heading and the thinking label sweep together
 * instead of each starting whenever it happened to mount.
 */
function syncPhase(node: HTMLSpanElement | null) {
  node?.style.setProperty("--shimmer-delay", `-${Date.now() % SHIMMER_MS}ms`);
}

const duration = { "--shimmer-dur": `${SHIMMER_MS}ms` } as CSSProperties;

/**
 * Text for work that is still in progress: a highlight sweeps across it
 * instead of a spinner. Pass `active={false}` once the work is done or is
 * waiting on someone else; the text is then plain and nothing animates.
 */
export function ShimmerText({
  active = true,
  className,
  style,
  ...props
}: ComponentPropsWithoutRef<"span"> & { active?: boolean }) {
  // Keyed on `active` so switching it on remounts the node, re-runs the ref and re-syncs the phase.
  return active ? (
    <span
      key="on"
      {...props}
      ref={syncPhase}
      // Not `cn`: tailwind-merge would read `text-shimmer` as a text colour and drop it beside another `text-*`.
      className={className ? `text-shimmer ${className}` : "text-shimmer"}
      style={{ ...duration, ...style }}
    />
  ) : (
    <span key="off" {...props} className={className} style={style} />
  );
}
