import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudRunProblem, formatTokenCount } from "@/lib/cloud-work-api";
import { RunProblemNotice, ThinkingIndicator } from "./cloud-run-status";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cloudRunProblem", () => {
  it("returns nothing for runs that did not go wrong", () => {
    expect(cloudRunProblem("completed", null)).toBeNull();
    expect(cloudRunProblem("running", null)).toBeNull();
    expect(cloudRunProblem("queued", null)).toBeNull();
  });
  it.each([
    ["provider_auth_failed", false, "administrator"],
    ["provider_model_unavailable", false, "models"],
    ["provider_rate_limited", true, undefined],
    ["provider_unavailable", true, undefined],
    ["provider_request_rejected", true, "models"],
    ["provider_insufficient_balance", true, undefined],
    ["provider_context_exceeded", false, "newConversation"],
    ["model_tool_call_invalid", true, "models"],
    ["worker_failed", true, "models"],
    [null, true, "models"],
  ] as const)("explains a failed run caused by %s", (code, retry, fix) => {
    const problem = cloudRunProblem("failed", code);
    expect(problem?.tone).toBe("error");
    expect(problem?.retry).toBe(retry);
    expect(problem?.fix).toBe(fix);
    expect(problem?.detail).toContain("saved");
  });
  it("distinguishes a user stop from an organization revocation", () => {
    expect(cloudRunProblem("cancelled", null)?.retry).toBe(true);
    const revoked = cloudRunProblem("cancelled", "policy_revoked");
    expect(revoked?.retry).toBe(false);
    expect(revoked?.fix).toBe("access");
    expect(cloudRunProblem("cancelled", "membership_revoked")?.retry).toBe(false);
  });
  it("describes a too-long conversation on its own terms, not as a model problem", () => {
    const problem = cloudRunProblem("failed", "provider_context_exceeded")!;
    expect(problem.title).toMatch(/too long/);
    expect(problem.detail).not.toMatch(/does not recognize/);
    // And a plain rejection no longer claims the conversation was too long.
    expect(cloudRunProblem("failed", "provider_request_rejected")!.detail).not.toMatch(/too long/);
  });
  it("formats context windows compactly", () => {
    expect(formatTokenCount(1_050_000)).toBe("1.05M");
    expect(formatTokenCount(1_047_576)).toBe("1.05M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(128_000)).toBe("128K");
    expect(formatTokenCount(32_768)).toBe("33K");
    expect(formatTokenCount(900)).toBe("900");
    expect(formatTokenCount(-1)).toBe("");
    expect(formatTokenCount(Number.NaN)).toBe("");
  });
  it("offers a retry for an interrupted run", () => {
    const problem = cloudRunProblem("interrupted", "worker_lease_expired");
    expect(problem?.retry).toBe(true);
    expect(problem?.title).toMatch(/interrupted/);
  });
});

describe("ThinkingIndicator", () => {
  const base = { label: "Thinking", workerAvailable: true, hasText: false };
  it("never repeats a running tool's title: the tool row says what it is doing, this line is the model", () => {
    const invocation = { id: "t", runId: "r", roundId: "round", callId: "c", name: "web_search", arguments: { query: "AI news" }, actionHash: "h", status: "running" as const, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };
    const props = { status: "running" as const, workerAvailable: true, hasText: true };
    render(<ThinkingIndicator {...props} text="" invocations={[invocation]} />);
    expect(screen.queryByText(/Searching the web/)).toBeNull();
    expect(screen.getByText("Thinking")).toBeTruthy();
  });
  it("only animates writing while text arrives", () => {
    const props = { status: "running" as const, workerAvailable: true, hasText: true };
    const { rerender } = render(<ThinkingIndicator {...props} text="Here is the answer." />);
    expect(screen.getByText("Writing")).toBeTruthy();
    rerender(<ThinkingIndicator {...props} text="Here is the answer." />);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Thinking")).toBeTruthy();
  });
  it("stops its animation as soon as an approval arrives even with a stale running status", () => {
    const { container } = render(<ThinkingIndicator {...base} status="running" approvals={[{
      id: "a", runId: "r", invocationId: "t", actionHash: "h", status: "pending", createdAt: "2026-10-13T00:00:00Z",
    }]} />);
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(container.querySelector(".text-shimmer")).toBeNull();
  });
  it("announces its label politely and shimmers the label itself, not a decorative icon", () => {
    const { container } = render(
      <ThinkingIndicator {...base} status="running" />,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // The shimmering node is the real, readable label: no hidden duplicates, no spinner or dots.
    const label = screen.getByText("Thinking");
    expect(label.classList.contains("text-shimmer")).toBe(true);
    expect(container.querySelectorAll(".text-shimmer")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
  });
  it("shimmers while queued for a worker but holds still while reconnecting", () => {
    const { rerender } = render(
      <ThinkingIndicator {...base} status="queued" label="Waiting for a worker" />,
    );
    expect(screen.getByText("Waiting for a worker").classList.contains("text-shimmer")).toBe(true);
    rerender(
      <ThinkingIndicator {...base} status="running" connectionStatus="Reconnecting to live updates…" />,
    );
    const label = screen.getByText("Reconnecting to live updates…");
    expect(label.classList.contains("text-shimmer")).toBe(false);
  });
  it("warns when a queued run has waited too long for a worker", () => {
    render(
      <ThinkingIndicator
        {...base}
        status="queued"
        label="Waiting for a worker"
        since={new Date(Date.now()).toISOString()}
      />,
    );
    expect(screen.queryByText(/Still waiting/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(screen.getByText(/Still waiting for a worker/)).toBeTruthy();
    // The elapsed clock is visual only, so the live region never reads it out.
    expect(screen.getByText("21s").getAttribute("aria-hidden")).toBe("true");
  });
  it("says so immediately when no worker is online", () => {
    render(
      <ThinkingIndicator
        {...base}
        status="queued"
        label="Waiting for a worker"
        workerAvailable={false}
      />,
    );
    expect(screen.getByText(/No worker is online/)).toBeTruthy();
  });
  it("shows no shimmer or clock while waiting on the member", () => {
    const { container } = render(
      <ThinkingIndicator
        {...base}
        status="awaitingApproval"
        label="Waiting for your approval"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.querySelector(".text-shimmer")).toBeNull();
    expect(screen.queryByText("30s")).toBeNull();
  });
});

describe("RunProblemNotice", () => {
  const actions = { onRetry: vi.fn(), onChooseModel: vi.fn() };
  it("keeps a deliberate stop concise while preserving its retry action", () => {
    const onRetry = vi.fn();
    const problem = cloudRunProblem("cancelled", null)!;
    render(<RunProblemNotice problem={problem} admin={false} disabled={false} onRetry={onRetry} onChooseModel={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Response stoppedTry again");
    expect(screen.queryByText(problem.detail)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("alerts and offers Try again for a retryable failure", () => {
    const problem = cloudRunProblem("failed", "provider_unavailable")!;
    render(
      <RunProblemNotice problem={problem} admin={false} disabled={false} {...actions} />,
    );
    // Polite, not assertive: reopening an old failed conversation must not interrupt.
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(actions.onRetry).toHaveBeenCalledOnce();
  });
  it("sends a member to the model list and an admin to the provider settings", () => {
    const problem = cloudRunProblem("failed", "provider_model_unavailable")!;
    const { rerender } = render(
      <RunProblemNotice problem={problem} admin={false} disabled={false} {...actions} />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View available models" }));
    expect(actions.onChooseModel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "Fix allowed models" })).toBeNull();
    rerender(
      <RunProblemNotice problem={problem} admin disabled={false} {...actions} />,
    );
    expect(
      screen.getByRole("link", { name: "Fix allowed models" }).getAttribute("href"),
    ).toBe("/work?section=providers");
  });
  it("offers a new conversation for an oversize one, and only when it can act", () => {
    const problem = cloudRunProblem("failed", "provider_context_exceeded")!;
    const onNewConversation = vi.fn();
    const { rerender } = render(
      <RunProblemNotice problem={problem} admin={false} disabled={false} {...actions} onNewConversation={onNewConversation} />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    rerender(
      <RunProblemNotice problem={problem} admin={false} disabled {...actions} onNewConversation={onNewConversation} />,
    );
    expect(screen.getByRole("button", { name: "Start a new conversation" }).hasAttribute("disabled")).toBe(true);
  });
  it("only shows a status for a plain stop and disables actions while busy", () => {
    const problem = cloudRunProblem("cancelled", null)!;
    render(
      <RunProblemNotice problem={problem} admin={false} disabled {...actions} />,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
