import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/client-api";
import { workApi } from "@/lib/work-api";
import { WorkModelDiscovery } from "./work-model-discovery";
vi.mock("@/lib/work-api", () => ({ workApi: vi.fn() }));
beforeEach(() => { vi.mocked(workApi).mockReset(); });

const chat = (id: string, extra = {}) => ({ id, name: id, category: "chat", runsInWork: true, ...extra });
const search = () => screen.getByRole("textbox", { name: "Search models" });
const rows = () => within(screen.getByRole("list", { name: "Provider models" })).getAllByRole("listitem").map((row) => row.textContent);
const apiError = (code: string, status: number) => new ClientApiError(code, "failed", status);
const addCustom = (id: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Custom model ID" }), { target: { value: id } });
};

function Harness({ initial = [], onToggle = vi.fn(), gatewayId = "g", onUpdateKey }: { initial?: string[]; onToggle?(id: string, allowed: boolean): void; gatewayId?: string; onUpdateKey?(): void }) {
  const [selected, setSelected] = useState(initial);
  return <WorkModelDiscovery gatewayId={gatewayId} disabled={false} selected={selected} onUpdateKey={onUpdateKey} onToggle={(id, allowed) => {
    onToggle(id, allowed);
    setSelected((current) => allowed ? [...current, id] : current.filter((value) => value !== id));
  }} />;
}

it("allows and removes a model in one action", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3"), chat("glm-5.2")] });
  const toggle = vi.fn();
  render(<Harness onToggle={toggle} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Allow glm-5.3" }));
  expect(toggle).toHaveBeenLastCalledWith("glm-5.3", true);
  expect(screen.getByText("1 of 32 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow glm-5.3" }));
  expect(toggle).toHaveBeenLastCalledWith("glm-5.3", false);
});

it("pins allowed models on load but never moves a row while it is being ticked", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("a"), chat("b"), chat("c")] });
  render(<Harness initial={["c"]} />);
  await screen.findByRole("checkbox", { name: "Allow a" });
  expect(rows().map((text) => text?.[0])).toEqual(["c", "a", "b"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow b" }));
  expect(rows().map((text) => text?.[0])).toEqual(["c", "a", "b"]);
});

it("distinguishes a free rate from an unknown one", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("m", { pricing: { prompt: 0 }, context_length: 1179648 })] });
  render(<Harness />);
  const row = (await screen.findByRole("checkbox", { name: "Allow m" })).closest("label")!;
  expect(row.textContent).toContain("Free");
  expect(row.textContent).toContain("—");
  expect(row.textContent).toContain("1.18M");
});

it("adds a custom model through its own control without submitting a surrounding form", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3")] });
  const toggle = vi.fn(), submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(<form onSubmit={submit}><Harness onToggle={toggle} /></form>);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  addCustom("my/custom");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Custom model ID" }), { key: "Enter" });
  expect(toggle).toHaveBeenCalledWith("my/custom", true);
  expect(submit).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Custom model ID" })).toBeNull();
  expect(screen.getByText("Custom")).toBeTruthy();
});

it("search only searches, even on Enter", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3")] });
  const toggle = vi.fn();
  render(<Harness onToggle={toggle} />);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  fireEvent.change(search(), { target: { value: "nothing-like-this" } });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.getByText(/No models match/)).toBeTruthy();
});

it("explains a duplicate custom model and keeps the form open", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3")] });
  const toggle = vi.fn();
  render(<Harness initial={["glm-5.3"]} onToggle={toggle} />);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  addCustom("glm-5.3");
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  expect(screen.getByRole("alert").textContent).toContain("already added");
  expect(toggle).not.toHaveBeenCalled();
});

it("cancels adding a custom model", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3")] });
  render(<Harness />);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  addCustom("draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  expect((screen.getByRole("textbox", { name: "Custom model ID" }) as HTMLInputElement).value).toBe("");
});

it("stops at the model limit but keeps removal available", async () => {
  const allowed = Array.from({ length: 32 }, (_, index) => `m${index}`);
  vi.mocked(workApi).mockResolvedValue({ models: [...allowed.map((id) => chat(id)), chat("extra")] });
  render(<Harness initial={allowed} />);
  expect((await screen.findByRole("checkbox", { name: "Allow extra" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Allow m0" }) as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText(/Limit reached/)).toBeTruthy();
  addCustom("custom");
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  expect(screen.getByRole("alert").textContent).toContain("up to 32");
});

it("blocks models Work cannot run, unless one is already allowed and must be removable", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("no-tools", { runsInWork: false }), chat("old", { runsInWork: false })] });
  render(<Harness initial={["old"]} />);
  expect((await screen.findByRole("checkbox", { name: "Allow no-tools" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Allow old" }) as HTMLInputElement).disabled).toBe(false);
  expect(screen.getAllByText("No tool calling").length).toBe(2);
});

it("lists media for reference in its own unit, with counts that follow the search", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [
    chat("glm-5.3"),
    { id: "seedream", name: "Seedream", category: "image", runsInWork: false, unitPrice: "$0.027 per image" },
    { id: "seedance", name: "Seedance", category: "video", runsInWork: false, unitPrice: "From $2.4 per 1M video tokens" },
  ] });
  render(<Harness />);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  expect(screen.getByRole("button", { name: "Chat 1" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Image 1" }));
  expect(screen.getByText("$0.027 per image")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/can't run image models/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Video 1" }));
  expect(screen.getByText("From $2.4 per 1M video tokens")).toBeTruthy();
  fireEvent.change(search(), { target: { value: "glm" } });
  expect(screen.getByRole("button", { name: "Video 0" })).toBeTruthy();
  expect(screen.getByText("No video models match “glm”.")).toBeTruthy();
});

it("keeps a media model that is already allowed visible so it can be removed", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("glm-5.3"), { id: "seedream", name: "Seedream", category: "image", runsInWork: false }] });
  render(<Harness initial={["seedream"]} />);
  expect((await screen.findByRole("checkbox", { name: "Allow seedream" }) as HTMLInputElement).checked).toBe(true);
});

it("shows no type controls for untyped provider listings", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [{ id: "custom", name: "Custom" }] });
  render(<Harness />);
  await screen.findByRole("checkbox", { name: "Allow custom" });
  expect(screen.queryByRole("group", { name: "Model type" })).toBeNull();
});

it("offers the key fix when the provider refuses the key, with allowed models still visible", async () => {
  vi.mocked(workApi).mockImplementation(() => Promise.reject(apiError("work_provider_key_refused", 422)));
  const update = vi.fn();
  render(<Harness initial={["saved-model"]} onUpdateKey={update} />);
  expect((await screen.findByRole("alert")).textContent).toContain("refused this API key");
  expect(screen.getByRole("checkbox", { name: "Allow saved-model" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Update key" }));
  expect(update).toHaveBeenCalled();
});

it.each([
  ["an expired session", () => apiError("unauthorized", 401), "session expired", "Sign in again"],
  ["a lost admin role", () => apiError("forbidden", 403), "Only organization administrators", null],
  ["rate limiting", () => apiError("rate_limited", 429), "Too many requests", null],
  ["a provider outage", () => apiError("work_model_discovery_failed", 502), "Couldn't load models", "Retry"],
  ["a network failure", () => new Error("offline"), "Couldn't load models", "Retry"],
])("explains %s without losing manual entry", async (_name, reason, text, action) => {
  vi.mocked(workApi).mockImplementation(() => Promise.reject(reason()));
  render(<Harness />);
  expect((await screen.findByRole("alert")).textContent).toContain(text);
  if (action) expect(screen.getByRole(action === "Retry" ? "button" : "link", { name: action })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add custom model" })).toBeTruthy();
});

it("keeps the last list when a refresh fails, then recovers", async () => {
  vi.mocked(workApi).mockResolvedValueOnce({ models: [chat("glm-5.3")] }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ models: [chat("glm-5.3"), chat("new")] });
  render(<Harness />);
  await screen.findByRole("checkbox", { name: "Allow glm-5.3" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Showing the last list");
  expect(screen.getByRole("checkbox", { name: "Allow glm-5.3" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("checkbox", { name: "Allow new" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows saved models while loading without calling them custom", async () => {
  vi.mocked(workApi).mockImplementation(() => new Promise(() => {}));
  render(<Harness initial={["glm-5.3"]} />);
  expect(screen.getByRole("status").textContent).toBe("Loading models…");
  expect(screen.getByRole("checkbox", { name: "Allow glm-5.3" })).toBeTruthy();
  expect(screen.queryByText("Custom")).toBeNull();
});

it("shows all models read-only in automatic mode, with a custom model still removable", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [chat("a"), chat("b"), chat("no-tools", { runsInWork: false })] });
  const toggle = vi.fn();
  render(<WorkModelDiscovery gatewayId="g" disabled={false} selected={["mine"]} automaticIds={["a", "b"]} onToggle={toggle} />);
  expect(screen.getByText("3 models enabled")).toBeTruthy();
  await screen.findByText("a");
  expect(screen.queryByRole("checkbox", { name: "Allow a" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow mine" }));
  expect(toggle).toHaveBeenCalledWith("mine", false);
});

it("explains an empty provider list", async () => {
  vi.mocked(workApi).mockResolvedValue({ models: [] });
  render(<Harness />);
  expect(await screen.findByText(/returned no models/)).toBeTruthy();
});

it("ignores a slow response from the previous connection", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(workApi).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ models: [chat("current")] });
  const view = render(<Harness gatewayId="old" />);
  view.rerender(<Harness gatewayId="new" />);
  await screen.findByRole("checkbox", { name: "Allow current" });
  finish({ models: [chat("stale")] });
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Allow stale" })).toBeNull());
});
