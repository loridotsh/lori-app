import { describe, expect, it } from "vitest";
import { MAX_ROUNDS, WRAP_UP_AT_CALLS, budgetNotice, mustWrapUp, stepsLeft, repeatedFailure } from "./run-budget.js";

describe("run budget", () => {
  it("ends repeated failed actions without treating unrelated reads as recovery", () => {
    const failed = { name: "read_file", arguments: { path: "missing" }, status: "failed" };
    const success = { ...failed, status: "completed" };
    expect(repeatedFailure([failed, failed])).toBe(false);
    expect(repeatedFailure([failed, success, failed])).toBe(false);
    expect(repeatedFailure([failed, { ...success, arguments: { path: "other" } }, failed, failed])).toBe(true);
    expect(mustWrapUp({ index: 3, calls: 3, stalled: true })).toBe(true);
    expect(budgetNotice({ index: 3, calls: 3, stalled: true })).toContain("Do not claim the task is complete");
  });
  it("lets a response use every round but the last for work", () => {
    expect(mustWrapUp({ index: 0, calls: 0 })).toBe(false);
    expect(mustWrapUp({ index: MAX_ROUNDS - 2, calls: 10 })).toBe(false);
    expect(mustWrapUp({ index: MAX_ROUNDS - 1, calls: 10 })).toBe(true);
  });

  it("wraps up before the shared core's 64-call limit, however few the rounds", () => {
    expect(WRAP_UP_AT_CALLS).toBeLessThan(64);
    expect(mustWrapUp({ index: 8, calls: WRAP_UP_AT_CALLS - 1 })).toBe(false);
    expect(mustWrapUp({ index: 8, calls: WRAP_UP_AT_CALLS })).toBe(true);
  });

  it("stays silent while there is plenty of room", () => {
    expect(budgetNotice({ index: 3, calls: 4 })).toBe("");
  });

  it("warns as the end approaches and says how to prioritize", () => {
    const notice = budgetNotice({ index: MAX_ROUNDS - 4, calls: 20 });
    expect(notice).toMatch(/Steps remaining: about \d/);
    expect(notice).toMatch(/combine independent tool calls/);
  });

  it("makes the final step a tool-free summary that invites the member to continue", () => {
    const notice = budgetNotice({ index: MAX_ROUNDS - 1, calls: 20 });
    expect(notice).toMatch(/tools are no longer available/);
    expect(notice).toMatch(/reply "continue"/);
    expect(budgetNotice({ index: 5, calls: WRAP_UP_AT_CALLS })).toMatch(/Step limit reached/);
  });

  it("counts steps left by whichever limit comes first", () => {
    expect(stepsLeft({ index: 0, calls: 0 })).toBe(Math.min(MAX_ROUNDS - 1, Math.floor(WRAP_UP_AT_CALLS / 2)));
    expect(stepsLeft({ index: MAX_ROUNDS - 1, calls: 0 })).toBe(0);
    expect(stepsLeft({ index: 0, calls: 999 })).toBe(0);
  });
});
