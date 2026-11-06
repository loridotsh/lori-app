import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { CloudSettings } from "./cloud-settings";

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));
const settings = { enabled: true, retentionDays: 90, revision: 1 };
beforeEach(() => {
  vi.mocked(cloudApi).mockResolvedValue(settings);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function open(onDirtyChange = vi.fn(), onSaved = vi.fn()) {
  const rendered = render(<CloudSettings onSaved={onSaved} onDirtyChange={onDirtyChange} />);
  const retention = screen.getByRole("textbox", {
    name: "Conversation retention in days",
  }) as HTMLInputElement;
  await waitFor(() => expect(retention.disabled).toBe(false));
  return { ...rendered, retention, onDirtyChange, onSaved };
}
describe("Cloud Work settings drafts", () => {
  it("reports unsaved settings and clears the dirty guard after a successful save", async () => {
    const { retention, onDirtyChange } = await open();
    fireEvent.change(retention, { target: { value: "30" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    vi.mocked(cloudApi).mockResolvedValue({ ...settings, retentionDays: 30, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    const nextUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(nextUnload);
    expect(nextUnload.defaultPrevented).toBe(false);
  });
  it("keeps unsaved settings when a load-latest discard is declined", async () => {
    const { retention } = await open();
    fireEvent.change(retention, { target: { value: "30" } });
    vi.mocked(cloudApi).mockRejectedValueOnce(new ClientApiError("revision_conflict", "Changed", 409));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByRole("alert");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const calls = vi.mocked(cloudApi).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Load latest settings" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(cloudApi).toHaveBeenCalledTimes(calls);
    expect(retention.value).toBe("30");
  });
  it("does not run a late save callback after leaving settings", async () => {
    const { retention, unmount, onSaved } = await open();
    fireEvent.change(retention, { target: { value: "30" } });
    let finish!: (value: typeof settings) => void;
    vi.mocked(cloudApi).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    unmount();
    await act(async () => { finish({ ...settings, retentionDays: 30, revision: 2 }); });
    expect(onSaved).not.toHaveBeenCalled();
  });
});
