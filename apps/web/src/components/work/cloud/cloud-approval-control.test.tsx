import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { CloudApprovalControl, validateApprovalPreferences } from "./cloud-approval-control";
import type { CloudMemberPreferences } from "@lori-enterprise/contracts";
vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<object>()), cloudApi: vi.fn() }));
const ask: CloudMemberPreferences = { approvalMode: "askMe", effectiveApprovalMode: "askMe", forcedAskMe: false, revision: 1 };
const auto: CloudMemberPreferences = { ...ask, approvalMode: "approveForMe", effectiveApprovalMode: "approveForMe", revision: 2 };
beforeEach(() => { vi.mocked(cloudApi).mockResolvedValue(ask); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
async function trigger() {
  const control = screen.getByRole("button", { name: "Approval mode" }) as HTMLButtonElement;
  await waitFor(() => expect(control.disabled).toBe(false));
  return control;
}
async function choose(name: RegExp) {
  await userEvent.click(await trigger());
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}
describe("Cloud approval preference control", () => {
  it("shows only server-confirmed state and persists a revision-bound choice", async () => {
    let finish!: (value: CloudMemberPreferences) => void;
    let saved = ask;
    vi.mocked(cloudApi).mockImplementation(async (_path, init) => init?.method === "PATCH" ? new Promise((resolve) => { finish = (value) => { saved = value; resolve(value); }; }) : saved);
    render(<CloudApprovalControl compact />);
    const control = await trigger();
    expect(control.textContent).toContain("Ask me");
    await choose(/Approve for me/);
    await waitFor(() => expect(control.disabled).toBe(true));
    expect(control.textContent).toContain("Ask me");
    const patch = vi.mocked(cloudApi).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ approvalMode: "approveForMe", expectedRevision: 1 });
    await act(async () => finish(auto));
    expect(control.textContent).toContain("Approve for me"); expect(control.disabled).toBe(false);
  });
  it("describes each mode in the menu and marks the current one", async () => {
    render(<CloudApprovalControl compact />);
    await userEvent.click(await trigger());
    const current = await screen.findByRole("menuitemradio", { name: /Ask me/ });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Approve for me/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Automatically approve permitted file changes/)).toBeTruthy();
    expect(screen.getByText(/Requests already waiting still need your decision/)).toBeTruthy();
  });
  it("makes organization-enforced Ask me read-only", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ ...auto, effectiveApprovalMode: "askMe", forcedAskMe: true });
    render(<CloudApprovalControl />);
    await screen.findByText("Managed by your organization");
    const control = screen.getByRole("button", { name: "Approval mode" }) as HTMLButtonElement;
    expect(control.disabled).toBe(true); expect(control.textContent).toContain("Ask me");
    expect(screen.getByText(/organization requires Ask me/)).toBeTruthy();
    await userEvent.click(control);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });
  it("keeps managed permissions as one disabled dropdown with a keyboard-accessible explanation", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ ...auto, effectiveApprovalMode: "askMe", forcedAskMe: true });
    render(<CloudApprovalControl compact />);
    const explanation = await screen.findByRole("group", { name: /Managed by your organization/ });
    expect(explanation.getAttribute("title")).toContain("organization requires Ask me");
    expect(explanation.getAttribute("tabindex")).toBe("0");
    const control = screen.getByRole("button", { name: "Approval mode" }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(control.querySelector(".lucide-chevron-down")).toBeTruthy();
    expect(screen.queryByText("Managed")).toBeNull();
    await userEvent.click(explanation);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(vi.mocked(cloudApi).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
  it("does not claim a failed change was saved and reloads a conflict", async () => {
    vi.mocked(cloudApi).mockImplementation(async (_path, init) => {
      if (init?.method === "PATCH") throw new ClientApiError("cloud_preferences_conflict", "Changed elsewhere", 409);
      return ask;
    });
    render(<CloudApprovalControl />); await choose(/Approve for me/);
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Approval mode" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload approval setting" }));
    expect((await trigger()).textContent).toContain("Ask me");
  });
  it("synchronizes another surface even when the saving control unmounts", async () => {
    let finish!: (value: CloudMemberPreferences) => void;
    let saved = ask;
    vi.mocked(cloudApi).mockImplementation(async (_path, init) => init?.method === "PATCH"
      ? new Promise((resolve) => { finish = (value) => { saved = value; resolve(value); }; }) : saved);
    const first = render(<CloudApprovalControl compact />);
    await choose(/Approve for me/);
    first.unmount();
    render(<CloudApprovalControl />); await trigger();
    await act(async () => finish(auto));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approval mode" }).textContent).toContain("Approve for me"));
  });
  it("refreshes on focus and rejects inconsistent server policy data", async () => {
    render(<CloudApprovalControl />); await trigger();
    vi.mocked(cloudApi).mockResolvedValue(auto); fireEvent.focus(window);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approval mode" }).textContent).toContain("Approve for me"));
    expect(() => validateApprovalPreferences({ ...auto, forcedAskMe: true })).toThrow();
    expect(() => validateApprovalPreferences({ ...ask, revision: 0 })).toThrow();
  });
  it("says when permissions cannot be loaded and offers a retry", async () => {
    vi.mocked(cloudApi).mockRejectedValueOnce(new ClientApiError("cloud_unavailable", "Offline", 503));
    render(<CloudApprovalControl compact />);
    expect((await screen.findByRole("button", { name: "Reload approval setting" })).getAttribute("title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approval mode" }).textContent).toContain("Permissions unavailable");
  });
});
