import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudApi } from "@/lib/cloud-work-api";
import { CloudDestinations } from "./cloud-destinations";
import type { CloudCapabilities } from "@lori-enterprise/contracts";

const capabilities: CloudCapabilities = {
  contractVersion: 1, enabled: true, available: true, providers: [],
  features: { chat: true, files: true, tools: true, memory: true, extensions: true },
};

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("Cloud destination mutation navigation", () => {
  it("does not request memory when organization policy disallows it", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ enabled: true, retentionDays: 90, revision: 1 });
    const onFailure = vi.fn();
    render(<CloudDestinations view="settings" capabilities={{ ...capabilities, features: { ...capabilities.features, memory: false } }} admin
      conversationId={null} onBack={vi.fn()} onSaved={vi.fn()} onFailure={onFailure} />);
    await waitFor(() => expect(vi.mocked(cloudApi)).toHaveBeenCalledWith("/settings", expect.anything()));
    expect(screen.getByText("Your organization has turned off memory for your account.")).toBeTruthy();
    expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.startsWith("/memory"))).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });
  it("keeps navigation busy until both settings and memory writes settle, then clears it on unmount", async () => {
    let finishPolicy!: (value: unknown) => void;
    let finishMemory!: (value: unknown) => void;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/settings") {
        if (init?.method === "PATCH")
          return new Promise((resolve) => { finishPolicy = resolve; });
        return { enabled: true, retentionDays: 90, revision: 1 };
      }
      if (path === "/memory/settings") {
        if (init?.method === "PATCH")
          return new Promise((resolve) => { finishMemory = resolve; });
        return { enabled: false, allowed: true, revision: 1 };
      }
      if (path.startsWith("/memory?")) return { notes: [] };
      throw new Error(path);
    });
    const onBusyChange = vi.fn();
    const onBack = vi.fn();
    const rendered = render(<CloudDestinations view="settings" capabilities={capabilities} admin
      conversationId={null} onBack={onBack} onSaved={vi.fn()} onFailure={vi.fn()}
      onBusyChange={onBusyChange} />);
    const memory = await screen.findByRole("switch", { name: "Use memory in Cloud Work" });
    const retention = screen.getByRole("textbox", { name: "Conversation retention in days" });
    await waitFor(() => expect((retention as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(retention, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.click(memory);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("button", { name: "Back to conversation" }).hasAttribute("disabled")).toBe(true);
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await act(async () => { finishPolicy({ enabled: true, retentionDays: 30, revision: 2 }); });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Back to conversation" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { finishMemory({ enabled: true, allowed: true, revision: 2 }); });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    fireEvent.click(memory);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    rendered.unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => { finishMemory({ enabled: false, allowed: true, revision: 3 }); });
    expect(onBack).not.toHaveBeenCalled();
  });
});
