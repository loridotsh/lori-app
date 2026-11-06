/**
 * How much work one response may do before it must wrap up.
 *
 * A response that runs out of steps used to fail outright, discarding the
 * summary the member needed. Instead the last step is always a tool-free
 * wrap-up: it reports what was finished, what remains, and invites the member
 * to say "continue". Everything completed is already saved.
 */

import { fingerprint } from "./security.js";

/** Provider rounds per response, the wrap-up included. The shared agent core allows at most 32. */
export const MAX_ROUNDS = 32;
/** The shared agent core refuses a turn past 64 tool calls; wrap up well before that. */
export const WRAP_UP_AT_CALLS = 52;
/** Steps before the end at which the model is told to prioritize. */
const WARN_STEPS = 4;

export interface RunProgress {
  /** Zero-based index of the round about to start. */
  index: number;
  /** Tool calls already made in this response. */
  calls: number;
  stalled?: boolean;
}

/** True when this round must answer in text only. */
export function mustWrapUp({ index, calls, stalled }: RunProgress): boolean {
  return stalled === true || index >= MAX_ROUNDS - 1 || calls >= WRAP_UP_AT_CALLS;
}

/** Reconstruct from authoritative receipts, so restart cannot reset the guard. */
export function repeatedFailure(calls: { name: string; arguments: unknown; status: string }[]): boolean {
  const failures = new Map<string, number>();
  for (const call of calls) {
    const key = fingerprint([call.name, call.arguments]);
    if (call.status === "completed") failures.delete(key);
    else if (call.status === "failed") {
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count >= 3) return true;
    }
  }
  return false;
}

/** Steps (rounds, then calls) left before the wrap-up, for the model's situational awareness. */
export function stepsLeft({ index, calls }: RunProgress): number {
  return Math.max(
    0,
    Math.min(MAX_ROUNDS - 1 - index, Math.floor((WRAP_UP_AT_CALLS - calls) / 2)),
  );
}

/** Appended to the system prompt as a run nears or reaches its limit; empty otherwise. */
export function budgetNotice(progress: RunProgress): string {
  if (progress.stalled)
    return "\nRepeated tool attempts have not made progress. Tools are disabled for this response. Report the blocker, confirmed results, and the prerequisite needed to continue. Do not claim the task is complete.";
  if (mustWrapUp(progress))
    return [
      "",
      "Step limit reached:",
      "- You have used every step available for one response, so tools are no longer available. Do not call or mention calling a tool.",
      "- Write the final reply now: what is finished (with file paths), what is not finished, and the single next step. Tell the member that everything completed is saved and they can reply \"continue\" to carry on from here.",
    ].join("\n");
  const left = stepsLeft(progress);
  return left <= WARN_STEPS
    ? [
        "",
        `Steps remaining: about ${left} before this response must end.`,
        "- Finish the essential work first and combine independent tool calls into one step. If the task cannot finish, stop at a clean point and say what remains.",
      ].join("\n")
    : "";
}
